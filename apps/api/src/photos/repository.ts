import type { DB } from "@gerlines/db";
import { type Kysely, sql } from "kysely";

/** One row of `vehicle_photo` with the name of its series. */
export interface PhotoRow {
  readonly photoId: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly rank: number;
  readonly fileTitle: string;
  readonly pageUrl: string;
  readonly author: string;
  readonly authorUrl: string | null;
  readonly licenceName: string;
  readonly licenceUrl: string | null;
  readonly focusX: number;
  readonly focusY: number;
  readonly mime: "image/jpeg" | "image/png";
  readonly small: { readonly width: number; readonly height: number; readonly sha256: string };
  readonly large: { readonly width: number; readonly height: number; readonly sha256: string };
}

export interface PhotoStore {
  photos(): Promise<readonly PhotoRow[]>;
}

interface Row {
  readonly photo_id: string;
  readonly series_id: string;
  readonly series_name: string;
  readonly rank: number;
  readonly file_title: string;
  readonly page_url: string;
  readonly author: string;
  readonly author_url: string | null;
  readonly licence_name: string;
  readonly licence_url: string | null;
  readonly focus_x: number;
  readonly focus_y: number;
  readonly mime: PhotoRow["mime"];
  readonly small_width: number;
  readonly small_height: number;
  readonly small_sha256: string;
  readonly large_width: number;
  readonly large_height: number;
  readonly large_sha256: string;
}

export class DatabasePhotoStore implements PhotoStore {
  private readonly db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async photos(): Promise<readonly PhotoRow[]> {
    const { rows } = await sql<Row>`
      SELECT p.photo_id, p.series_id, s.name AS series_name, p.rank, p.file_title, p.page_url,
             p.author, p.author_url, p.licence_name, p.licence_url, p.focus_x::float8 AS focus_x,
             p.focus_y::float8 AS focus_y, p.mime, p.small_width, p.small_height, p.small_sha256,
             p.large_width, p.large_height, p.large_sha256
        FROM vehicle_photo p JOIN vehicle_series s USING (series_id)
       ORDER BY s.name, p.series_id, p.rank`.execute(this.db);
    return rows.map((row) => ({
      photoId: row.photo_id,
      seriesId: row.series_id,
      seriesName: row.series_name,
      rank: row.rank,
      fileTitle: row.file_title,
      pageUrl: row.page_url,
      author: row.author,
      authorUrl: row.author_url,
      licenceName: row.licence_name,
      licenceUrl: row.licence_url,
      focusX: row.focus_x,
      focusY: row.focus_y,
      mime: row.mime,
      small: { width: row.small_width, height: row.small_height, sha256: row.small_sha256 },
      large: { width: row.large_width, height: row.large_height, sha256: row.large_sha256 },
    }));
  }
}
