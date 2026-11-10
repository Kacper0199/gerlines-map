import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotoCredits } from "@gerlines/schema/photos";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { fixedWindowLimiter } from "../search/rate-limit.ts";
import type { PhotoRow, PhotoStore } from "./repository.ts";
import { PHOTO_FILE_RATE_LIMIT } from "./routes.ts";
import { PhotoCatalogueUnavailableError, PhotoService, photoUrl } from "./service.ts";

const SMALL = Buffer.from("small jpeg bytes");
const LARGE = Buffer.from("large jpeg bytes");

function sha(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function row(changes: Partial<PhotoRow> = {}): PhotoRow {
  return {
    photoId: "db-403-p1",
    seriesId: "db-403",
    seriesName: "ICE 3",
    rank: 1,
    fileTitle: "File:ICE 3 in Köln.jpg",
    pageUrl: "https://commons.wikimedia.org/wiki/File:ICE_3_in_K%C3%B6ln.jpg",
    author: "Rail Fan",
    authorUrl: "https://commons.wikimedia.org/wiki/User:Rail_Fan",
    licenceName: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    focusX: 0.5,
    focusY: 0.6,
    mime: "image/jpeg",
    small: { width: 330, height: 220, sha256: sha(SMALL) },
    large: { width: 960, height: 640, sha256: sha(LARGE) },
    ...changes,
  };
}

function folder(rows: readonly PhotoRow[]): string {
  const root = mkdtempSync(join(tmpdir(), "photos-"));
  for (const r of rows) {
    mkdirSync(join(root, r.seriesId), { recursive: true });
    writeFileSync(join(root, r.seriesId, `${r.photoId}-330.jpg`), SMALL);
    writeFileSync(join(root, r.seriesId, `${r.photoId}-960.jpg`), LARGE);
  }
  return root;
}

class FakeStore implements PhotoStore {
  calls = 0;
  rows: readonly PhotoRow[];
  failure: Error | null = null;
  hang = false;

  constructor(rows: readonly PhotoRow[]) {
    this.rows = rows;
  }

  async photos(): Promise<readonly PhotoRow[]> {
    this.calls += 1;
    if (this.hang) return new Promise(() => {});
    if (this.failure) throw this.failure;
    return this.rows;
  }
}

function harness(
  rows: readonly PhotoRow[] = [row()],
  stored: readonly PhotoRow[] = rows,
  options: { now?: () => number; maxCachedFiles?: number } = {},
) {
  const lines: string[] = [];
  const store = new FakeStore(rows);
  const root = folder(stored);
  const service = new PhotoService({
    store,
    root,
    logger: { error: (line) => void lines.push(line) },
    ...options,
  });
  const app = createApp({
    photos: service,
    logger: { error: (line) => void lines.push(line) },
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, service, store, lines, root };
}

function fileName(url: string): string {
  return url.replace("/api/v1/photos/", "");
}

describe("PhotoService", () => {
  it("gives each series its rank 1 photo with the full credit", async () => {
    const second = row({ photoId: "db-403-p2", rank: 2 });
    const { service } = harness([second, row()]);
    const photo = await service.forSeries("db-403");
    expect(photo?.photoId).toBe("db-403-p1");
    expect(photo?.small.url).toBe(`/api/v1/photos/db-403-p1-330-${sha(SMALL).slice(0, 12)}.jpg`);
    expect(photo).toMatchObject({
      title: "ICE 3 in Köln.jpg",
      author: "Rail Fan",
      licence: "CC BY-SA 4.0",
      focus: { x: 0.5, y: 0.6 },
    });
    expect(photo).not.toHaveProperty("seriesName");
    expect(await service.forSeries("db-412")).toBeNull();
    expect((await service.credits()).map((p) => p.photoId)).toEqual(["db-403-p2", "db-403-p1"]);
  });

  it("leaves out a photo whose copies are not on disk", async () => {
    const missing = row({ photoId: "db-412-p1", seriesId: "db-412", seriesName: "ICE 4" });
    const { service, lines } = harness([row(), missing], [row()]);
    expect(await service.forSeries("db-412")).toBeNull();
    expect(lines).toEqual(["photo db-412-p1 is not stored, left out"]);
  });

  it("serves a copy only under its exact name and with its recorded hash", async () => {
    const { service, lines } = harness();
    const name = fileName(photoUrl(row(), 960));
    expect((await service.file(name))?.body.equals(LARGE)).toBe(true);
    for (const wrong of [
      name.replace("-960-", "-330-"),
      name.replace(".jpg", ".png"),
      "db-403-p9-960-000000000000.jpg",
      "../db-403/db-403-p1-960.jpg",
      "db-403-p1-960.jpg",
    ]) {
      expect(await service.file(wrong)).toBeNull();
    }
    expect(lines).toEqual([]);
    const swapped = harness();
    expect(await swapped.service.forSeries("db-403")).not.toBeNull();
    writeFileSync(
      join(swapped.root, "db-403", "db-403-p1-330.jpg"),
      Buffer.from("small jpeg bytez"),
    );
    expect(await swapped.service.file(fileName(photoUrl(row(), 330)))).toBeNull();
    expect(swapped.lines).toEqual(["photo db-403-p1 at 330 px differs from its record"]);
  });

  it("leaves out a row whose series id would leave the photo folder", async () => {
    const lines: string[] = [];
    const escaping = new PhotoService({
      store: new FakeStore([row({ seriesId: "../../etc" })]),
      root: folder([]),
      logger: { error: (line) => void lines.push(line) },
    });
    expect(await escaping.forSeries("../../etc")).toBeNull();
    expect(lines).toEqual(["photo db-403-p1 is not stored, left out"]);
  });

  it("keeps the last catalogue when a refresh fails", async () => {
    let at = 0;
    const store = new FakeStore([row()]);
    const lines: string[] = [];
    const service = new PhotoService({
      store,
      root: folder([row()]),
      logger: { error: (line) => void lines.push(line) },
      now: () => at,
      catalogueTtlMs: 1_000,
    });
    expect(await service.forSeries("db-403")).not.toBeNull();
    store.failure = new Error("db down");
    at = 5_000;
    expect(await service.forSeries("db-403")).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines).toEqual(["photo catalogue refresh failed: Error"]);
    expect(store.calls).toBe(2);
  });

  it("waits out a retry period after a failed first load instead of asking the store each time", async () => {
    let at = 0;
    const { service, store, lines } = harness([row()], [row()], { now: () => at });
    store.failure = new Error("db down");
    await expect(service.forSeries("db-403")).rejects.toBeInstanceOf(
      PhotoCatalogueUnavailableError,
    );
    for (let i = 0; i < 5; i += 1) {
      await expect(service.forSeries("db-403")).rejects.toBeInstanceOf(
        PhotoCatalogueUnavailableError,
      );
    }
    expect(store.calls).toBe(1);
    expect(lines).toEqual(["photo catalogue load failed: Error"]);
    store.failure = null;
    at = 10_000;
    expect((await service.forSeries("db-403"))?.photoId).toBe("db-403-p1");
    expect(store.calls).toBe(2);
  });

  it("warms the catalogue without throwing when the store is down", async () => {
    const { service, store, lines } = harness();
    store.failure = new Error("db down");
    await service.warm();
    expect(store.calls).toBe(1);
    expect(lines).toEqual(["photo catalogue load failed: Error"]);
    const up = harness();
    await up.service.warm();
    expect(up.store.calls).toBe(1);
    expect((await up.service.forSeries("db-403"))?.photoId).toBe("db-403-p1");
    expect(up.store.calls).toBe(1);
  });

  it("leaves out a photo whose copy on disk does not match its recorded hash", async () => {
    const corrupt = row({ photoId: "db-412-p1", seriesId: "db-412", seriesName: "ICE 4" });
    const { service, lines, root } = harness([row(), corrupt]);
    writeFileSync(join(root, "db-412", "db-412-p1-960.jpg"), Buffer.from("large jpeg bytez"));
    expect(await service.forSeries("db-412")).toBeNull();
    expect((await service.credits()).map((p) => p.photoId)).toEqual(["db-403-p1"]);
    expect(lines).toEqual(["photo db-412-p1 is not stored, left out"]);
  });

  it("reads a copy once for concurrent requests and evicts the least recently used copy", async () => {
    const rows = [1, 2, 3].map((rank) =>
      row({
        photoId: `db-403-p${rank}`,
        rank,
        large: { ...row().large, sha256: sha(Buffer.from(`large ${rank}`)) },
      }),
    );
    const { service, root } = harness(rows, [], { maxCachedFiles: 2 });
    for (const r of rows) {
      mkdirSync(join(root, r.seriesId), { recursive: true });
      writeFileSync(join(root, r.seriesId, `${r.photoId}-330.jpg`), SMALL);
      writeFileSync(join(root, r.seriesId, `${r.photoId}-960.jpg`), `large ${r.rank}`);
    }
    const [a, b, c] = rows.map((r) => fileName(photoUrl(r, 960)));
    const together = await Promise.all(Array.from({ length: 8 }, () => service.file(a ?? "")));
    expect(new Set(together).size).toBe(1);
    const first = together[0];
    const second = await service.file(b ?? "");
    expect(await service.file(a ?? "")).toBe(first);
    await service.file(c ?? "");
    expect(await service.file(a ?? "")).toBe(first);
    expect(await service.file(b ?? "")).not.toBe(second);
  });
});

describe("photo routes", () => {
  it("lists the credits with an hour of cache", async () => {
    const { app } = harness();
    const response = await app.request("/api/v1/photos");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = PhotoCredits.parse(await response.json());
    expect(body.photos[0]?.seriesName).toBe("ICE 3");
  });

  it("serves a copy with its type, an immutable cache, an ETag and nosniff", async () => {
    const { app } = harness();
    const url = photoUrl(row(), 330);
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await response.arrayBuffer()).equals(SMALL)).toBe(true);
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toBe(`"${sha(SMALL)}"`);
    const again = await app.request(url, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("limits photo files per client, 300 a minute by default", async () => {
    expect(PHOTO_FILE_RATE_LIMIT).toBe(300);
    let peer = "203.0.113.1";
    const service = harness().service;
    const app = createApp({
      photos: service,
      logger: { error: () => undefined },
      peerAddress: () => peer,
      photoFileLimiter: fixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
    });
    const url = photoUrl(row(), 330);
    expect((await app.request(url)).status).toBe(200);
    const refused = await app.request(url);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    peer = "203.0.113.2";
    expect((await app.request(url)).status).toBe(200);
  });

  it("answers 404 for names it does not know, traversal included", async () => {
    const { app } = harness();
    for (const path of [
      "/api/v1/photos/db-403-p1-330.jpg",
      "/api/v1/photos/..%2F..%2Fcandidates.json",
      "/api/v1/photos/%2e%2e%2fsecret",
      `/api/v1/photos/${"a".repeat(120)}`,
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    }
  });

  it("answers 503 when no photo service is configured or the catalogue cannot load", async () => {
    const app = createApp({});
    expect((await app.request("/api/v1/photos")).status).toBe(503);
    expect((await app.request(photoUrl(row(), 330))).status).toBe(503);
    const { app: failing, store, lines } = harness();
    store.failure = new Error("db down");
    for (const path of ["/api/v1/photos", photoUrl(row(), 330), "/api/v1/photos"]) {
      const response = await failing.request(path);
      expect(response.status, path).toBe(503);
      expect(await response.json()).toEqual({ error: "photos_unavailable" });
      expect(response.headers.get("retry-after")).toBe("10");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(store.calls).toBe(1);
    expect(lines).toEqual(["photo catalogue load failed: Error"]);
  });

  it("answers 500 for an unexpected failure and logs it at most once per interval", async () => {
    const lines: string[] = [];
    const app = createApp({
      now: () => 0,
      photos: {
        forSeries: async () => null,
        credits: async () => Promise.reject(new TypeError("broken")),
        file: async () => Promise.reject(new TypeError("broken")),
      },
      logger: { error: (line) => void lines.push(line) },
    });
    for (let i = 0; i < 4; i += 1) {
      expect((await app.request("/api/v1/photos")).status).toBe(500);
      expect((await app.request(photoUrl(row(), 330))).status).toBe(500);
    }
    expect(lines).toEqual(["photo request failed: TypeError"]);
  });
});
