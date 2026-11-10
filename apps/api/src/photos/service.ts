import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PHOTO_FILE, type TrainPhoto } from "@gerlines/schema";
import { PHOTOS_PATH, type PhotoCredit } from "@gerlines/schema/photos";
import type { PhotoRow, PhotoStore } from "./repository.ts";

export interface PhotoServiceOptions {
  readonly store: PhotoStore;
  /** The folder of the local copies, `data/photos` in development. */
  readonly root: string;
  readonly logger: { error(line: string): void };
  readonly now?: () => number;
  readonly catalogueTtlMs?: number;
  readonly maxCachedFiles?: number;
}

export interface PhotoFile {
  readonly body: Buffer;
  readonly contentType: "image/jpeg" | "image/png";
  readonly sha256: string;
}

type WidthClass = 330 | 960;

interface Entry {
  readonly row: PhotoRow;
  readonly photo: PhotoCredit;
}

interface Catalogue {
  readonly bySeries: ReadonlyMap<string, TrainPhoto>;
  readonly credits: readonly PhotoCredit[];
  readonly byId: ReadonlyMap<string, Entry>;
  readonly loadedAt: number;
}

const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;
const HASH_DIGITS = 12;
const MAX_CACHED_FILES = 64;
const RETRY_MS = 60_000;

/** After a failed first load the catalogue is not asked for again for this long. */
export const COLD_RETRY_MS = 10_000;

/** The catalogue has never loaded and its last load failed less than `COLD_RETRY_MS` ago. */
export class PhotoCatalogueUnavailableError extends Error {
  override readonly name = "PhotoCatalogueUnavailableError";
}

export function photoUrl(row: PhotoRow, width: WidthClass): string {
  const sha = width === 330 ? row.small.sha256 : row.large.sha256;
  return `${PHOTOS_PATH}/${row.photoId}-${width}-${sha.slice(0, HASH_DIGITS)}.${EXTENSION[row.mime]}`;
}

export function photoOf(row: PhotoRow): PhotoCredit {
  return {
    photoId: row.photoId,
    seriesId: row.seriesId,
    seriesName: row.seriesName,
    small: { url: photoUrl(row, 330), width: row.small.width, height: row.small.height },
    large: { url: photoUrl(row, 960), width: row.large.width, height: row.large.height },
    focus: { x: row.focusX, y: row.focusY },
    title: row.fileTitle.replace(/^File:/, ""),
    author: row.author,
    authorUrl: row.authorUrl,
    licence: row.licenceName,
    licenceUrl: row.licenceUrl,
    sourceUrl: row.pageUrl,
  };
}

function trainPhoto({ seriesName: _name, ...photo }: PhotoCredit): TrainPhoto {
  return photo;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

/**
 * Approved vehicle photos (WP-6.3): the rank-1 photo of each series for the train card, every photo
 * for the credits page, and the local copies. Rows come from `vehicle_photo` and are kept for
 * `catalogueTtlMs`; a row whose copies are not on disk with their recorded SHA-256 is left out. A
 * copy is served only when its SHA-256 is the recorded one, so a swapped or truncated file is never
 * sent. Until a first load succeeds, a failed load is retried at most once per `COLD_RETRY_MS`, and
 * calls in between fail at once with `PhotoCatalogueUnavailableError`.
 */
export class PhotoService {
  private current: Catalogue | null = null;
  private loading: Promise<Catalogue> | null = null;
  private retryAt = Number.NEGATIVE_INFINITY;
  private readonly files = new Map<string, PhotoFile>();
  private readonly reading = new Map<string, Promise<PhotoFile | null>>();
  private readonly verified = new Map<string, string>();
  private readonly root: string;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxCachedFiles: number;
  private readonly options: PhotoServiceOptions;

  constructor(options: PhotoServiceOptions) {
    this.options = options;
    this.root = resolve(options.root);
    this.now = options.now ?? Date.now;
    this.ttl = options.catalogueTtlMs ?? 600_000;
    this.maxCachedFiles = options.maxCachedFiles ?? MAX_CACHED_FILES;
  }

  /** Loads the catalogue ahead of the first request; a failure is logged and retried later. */
  async warm(): Promise<void> {
    await this.catalogue().catch(() => undefined);
  }

  async forSeries(seriesId: string): Promise<TrainPhoto | null> {
    return (await this.catalogue()).bySeries.get(seriesId) ?? null;
  }

  async credits(): Promise<readonly PhotoCredit[]> {
    return (await this.catalogue()).credits;
  }

  /** The copy a `/api/v1/photos/{file}` name stands for, or null when it names none. */
  async file(name: string): Promise<PhotoFile | null> {
    const match = PHOTO_FILE.exec(`${PHOTOS_PATH}/${name}`);
    if (!match) return null;
    const [, photoId = "", width, hash, extension] = match;
    const entry = (await this.catalogue()).byId.get(photoId);
    if (!entry) return null;
    const widthClass: WidthClass = width === "330" ? 330 : 960;
    const expected = widthClass === 330 ? entry.row.small.sha256 : entry.row.large.sha256;
    if (!expected.startsWith(hash ?? "-") || EXTENSION[entry.row.mime] !== extension) return null;
    const cached = this.files.get(expected);
    if (cached) {
      this.files.delete(expected);
      this.files.set(expected, cached);
      return cached;
    }
    const pending = this.reading.get(expected);
    if (pending) return pending;
    const read = this.read(entry.row, widthClass, expected).finally(() => {
      this.reading.delete(expected);
    });
    this.reading.set(expected, read);
    return read;
  }

  private async read(
    row: PhotoRow,
    width: WidthClass,
    expected: string,
  ): Promise<PhotoFile | null> {
    const body = await readFile(this.pathOf(row, width)).catch(() => null);
    if (body === null) return null;
    if (sha256(body) !== expected) {
      this.options.logger.error(`photo ${row.photoId} at ${width} px differs from its record`);
      return null;
    }
    const file = { body, contentType: row.mime, sha256: expected };
    if (this.files.size >= this.maxCachedFiles) {
      const oldest = this.files.keys().next().value;
      if (oldest !== undefined) this.files.delete(oldest);
    }
    this.files.set(expected, file);
    return file;
  }

  private pathOf(row: PhotoRow, width: WidthClass): string {
    const path = resolve(
      join(this.root, row.seriesId, `${row.photoId}-${width}.${EXTENSION[row.mime]}`),
    );
    if (!path.startsWith(this.root + sep)) {
      throw new Error(`photo path of ${row.photoId} leaves the photo folder`);
    }
    return path;
  }

  private async stored(row: PhotoRow): Promise<boolean> {
    for (const width of [330, 960] as const) {
      const expected = width === 330 ? row.small : row.large;
      if (expected.width !== width) return false;
      const path = this.pathOf(row, width);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return false;
      const seen = `${expected.sha256} ${info.size} ${info.mtimeMs}`;
      if (this.verified.get(path) === seen) continue;
      const body = await readFile(path).catch(() => null);
      if (body === null || sha256(body) !== expected.sha256) return false;
      this.verified.set(path, seen);
    }
    return true;
  }

  private async catalogue(): Promise<Catalogue> {
    const at = this.now();
    const current = this.current;
    if (current === null) {
      if (this.loading) return this.loading;
      if (at < this.retryAt) {
        throw new PhotoCatalogueUnavailableError("the photo catalogue has not loaded yet");
      }
      this.loading = this.fetch(at)
        .catch((error: unknown) => {
          this.retryAt = at + COLD_RETRY_MS;
          this.options.logger.error(`photo catalogue load failed: ${errorName(error)}`);
          throw new PhotoCatalogueUnavailableError("the photo catalogue could not load", {
            cause: error,
          });
        })
        .finally(() => {
          this.loading = null;
        });
      return this.loading;
    }
    if (at - current.loadedAt > this.ttl && this.loading === null && at >= this.retryAt) {
      this.loading = this.fetch(at)
        .catch((error: unknown) => {
          this.retryAt = at + Math.min(this.ttl, RETRY_MS);
          this.options.logger.error(`photo catalogue refresh failed: ${errorName(error)}`);
          return current;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return current;
  }

  private async fetch(at: number): Promise<Catalogue> {
    const rows = await this.options.store.photos();
    const kept: Entry[] = [];
    for (const row of rows) {
      const stored = await this.stored(row).catch(() => false);
      if (stored) {
        kept.push({ row, photo: photoOf(row) });
      } else {
        this.options.logger.error(`photo ${row.photoId} is not stored, left out`);
      }
    }
    const bySeries = new Map<string, TrainPhoto>();
    for (const { row, photo } of [...kept].sort((a, b) => a.row.rank - b.row.rank)) {
      if (!bySeries.has(row.seriesId)) bySeries.set(row.seriesId, trainPhoto(photo));
    }
    this.current = {
      bySeries,
      credits: kept.map(({ photo }) => photo),
      byId: new Map(kept.map((entry) => [entry.row.photoId, entry])),
      loadedAt: at,
    };
    return this.current;
  }
}
