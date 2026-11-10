import { createServer, type Server, type Socket } from "node:net";
import { createDatabase } from "@gerlines/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../log.ts";
import { RECORDER_CONNECT_TIMEOUT_MS, recorderDatabaseOptions } from "./database.ts";

const sockets: Socket[] = [];
let silent: Server;
let port: number;

beforeAll(async () => {
  silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  port = (silent.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
});

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: { log: (level, message, fields) => lines.push(`${level} ${message} ${fields?.error}`) },
  };
}

describe("recorderDatabaseOptions", () => {
  it("logs an idle connection error instead of ending the process", () => {
    const { logger, lines } = capture();
    const options = recorderDatabaseOptions("postgres://u@127.0.0.1:1/gerlines", logger);

    options.onPoolError?.(new Error("terminating connection due to administrator command"));

    expect(lines).toEqual([
      "warn database connection failed, the index reconciles from files later terminating connection due to administrator command",
    ]);
  });

  it("gives up connecting to a database that never answers after about five seconds", async () => {
    const { logger } = capture();
    const db = createDatabase(
      recorderDatabaseOptions(`postgres://u:p@127.0.0.1:${port}/gerlines`, logger),
    );
    const started = Date.now();
    try {
      await expect(sql`select 1`.execute(db)).rejects.toThrow(/timeout/i);
    } finally {
      await db.destroy().catch(() => undefined);
    }
    expect(RECORDER_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(Date.now() - started).toBeLessThan(RECORDER_CONNECT_TIMEOUT_MS + 3_000);
  }, 15_000);
});
