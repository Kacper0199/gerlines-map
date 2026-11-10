import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { type Env, loadRecorderConfig } from "../env.ts";
import { loadClientCertificate } from "../fetch/client-certificate.ts";
import { createTlsFixtures, type TlsFixtures } from "../fetch/tls.test-support.ts";
import type { Logger, LogLevel } from "../log.ts";
import { MOBILITHEK_SOURCE_ID, mobilithekFeed, PROVIDER_LIMITS } from "../sources.ts";
import { TMP_DIR } from "../storage/paths.ts";
import { listSidecars, readFetchRecords, readSegmentPayloads } from "../storage/reader.ts";
import { IndexSink } from "./index-sink.ts";
import { configuredSources, selectSources } from "./recorder.ts";
import { type RunnerContext, SourceRunner } from "./source-runner.ts";

const subscriptionId = "1000000000000000042";
const PASSWORD_VARIABLE = "MOBILITHEK_CERT_PASSWORD";
const feed = readFileSync(new URL("../../test/fixtures/vbn-gtfs-rt-first40.pb", import.meta.url));
const lastModified = "Thu, 29 Oct 2026 20:00:00 GMT";
let tls: TlsFixtures;
let server: Server;
let base: string;
let root: string;
const seen: { url: string; cn: string | null; ifModifiedSince?: string; ifNoneMatch?: string }[] =
  [];

function collecting(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (_level: LogLevel, message: string, fields?: Record<string, unknown>) => {
        lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    },
  };
}

beforeAll(async () => {
  tls = await createTlsFixtures();
  server = createServer(
    {
      key: tls.serverKey,
      cert: tls.serverCert,
      ca: [tls.caCert],
      requestCert: true,
      rejectUnauthorized: false,
    },
    (request, response) => {
      const socket = request.socket as TLSSocket;
      const cn = socket.authorized ? String(socket.getPeerCertificate().subject.CN) : null;
      seen.push({
        url: request.url ?? "",
        cn,
        ...(request.headers["if-modified-since"]
          ? { ifModifiedSince: request.headers["if-modified-since"] }
          : {}),
        ...(request.headers["if-none-match"]
          ? { ifNoneMatch: request.headers["if-none-match"] }
          : {}),
      });
      if (!cn) {
        response.writeHead(400).end();
        return;
      }
      if (request.headers["if-modified-since"] === lastModified) {
        response.writeHead(304, { "last-modified": lastModified, etag: '"m1"' }).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "last-modified": lastModified,
          etag: '"m1"',
        })
        .end(gzipSync(feed));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await tls.cleanup();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gerlines-mobilithek-"));
  await mkdir(join(root, TMP_DIR), { recursive: true });
  seen.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function env(extra: Env = {}): Env {
  return {
    RECORDINGS_DIR: "/recordings",
    MOBILITHEK_CERT_P12: tls.p12Path,
    [PASSWORD_VARIABLE]: tls.password,
    MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID: subscriptionId,
    ...extra,
  };
}

describe("delfi-mobilithek-rt source", () => {
  it("polls the subscription every minute with the certificate on its own provider", () => {
    const { logger } = collecting();
    const source = selectSources(loadRecorderConfig(env()), logger).find(
      (candidate) => candidate.id === MOBILITHEK_SOURCE_ID,
    );
    expect(source).toBeDefined();
    expect(source?.url).toBe(
      `https://mobilithek.info:8443/mobilithek/api/v1.0/container/subscription?subscriptionID=${subscriptionId}`,
    );
    expect(source?.periodMs).toBe(60_000);
    expect(source?.provider).toBe("mobilithek.info");
    expect(PROVIDER_LIMITS["mobilithek.info"]).toBeDefined();
    expect(source?.clientCertificate).toBeDefined();
    expect(source?.secrets).toContain(subscriptionId);
    expect(source?.metadata.attribution).toMatch(/DELFI/);
    expect(JSON.stringify(source)).not.toContain(tls.password);
  });

  it("keeps the mirror source next to it (D-041: primary and fallback)", () => {
    const ids = configuredSources(loadRecorderConfig(env())).map((source) => source.id);
    expect(ids).toContain("delfi-gtfs-rt");
    expect(ids).toContain(MOBILITHEK_SOURCE_ID);
  });

  it("is skipped with a reason when a variable is missing", () => {
    for (const missing of [
      "MOBILITHEK_CERT_P12",
      "MOBILITHEK_CERT_PASSWORD",
      "MOBILITHEK_DELFI_RT_SUBSCRIPTION_ID",
    ]) {
      const { logger, lines } = collecting();
      const sources = selectSources(loadRecorderConfig(env({ [missing]: "" })), logger);
      expect(
        sources.some((source) => source.id === MOBILITHEK_SOURCE_ID),
        missing,
      ).toBe(false);
      expect(lines.join("\n"), missing).toMatch(new RegExp(`${MOBILITHEK_SOURCE_ID}.*${missing}`));
    }
  });

  it("is skipped, without the password in the reason, when the certificate does not open", () => {
    const { logger, lines } = collecting();
    const wrong = "made-up-wrong-password-4444";
    const sources = selectSources(loadRecorderConfig(env({ [PASSWORD_VARIABLE]: wrong })), logger);
    expect(sources.some((source) => source.id === MOBILITHEK_SOURCE_ID)).toBe(false);
    const text = lines.join("\n");
    expect(text).toMatch(/cannot open the client certificate/);
    expect(text).not.toContain(wrong);
  });

  it("resolves a relative certificate path against the workspace root", () => {
    const config = loadRecorderConfig(env({ MOBILITHEK_CERT_P12: "secrets/mobilithek/x.p12" }));
    expect(config.mobilithek?.certificatePath).toMatch(/\/secrets\/mobilithek\/x\.p12$/);
    expect(config.mobilithek.certificatePath?.startsWith("/")).toBe(true);
    expect(JSON.stringify(config.mobilithek)).not.toContain(tls.password);
  });
});

function context(logger: Logger): RunnerContext {
  return {
    root,
    userAgent: "gerlines/0.1.0 (+test@example.org)",
    clock: systemClock,
    random: () => 0,
    logger,
    index: new IndexSink(null, logger),
    gate: {
      run: async (_p, _s, task) => {
        await task();
        return { ran: true };
      },
      pause: () => undefined,
    },
    isPaused: () => false,
    seedDir: null,
    signal: new AbortController().signal,
  };
}

describe("recording delfi-mobilithek-rt", () => {
  it("stores the decoded feed, then costs a 304 for an unchanged minute, with no secret on disk", async () => {
    const certificate = loadClientCertificate(tls.p12Path, tls.password, { ca: tls.caCert });
    const source = mobilithekFeed(
      { certificate, subscriptionId, problem: null },
      `${base}/mobilithek/api/v1.0`,
    );
    const { logger, lines } = collecting();
    const runner = new SourceRunner(
      source,
      context(logger),
      "0199f000-0000-7000-8000-000000000001",
    );
    await runner.init();
    await runner.attempt();
    await runner.attempt();
    certificate.close();

    expect(seen.map((request) => request.cn)).toEqual(["gerlines-recorder", "gerlines-recorder"]);
    expect(seen[1]).toMatchObject({ ifModifiedSince: lastModified, ifNoneMatch: '"m1"' });
    const records = await readFetchRecords(root, await listSidecars(root, MOBILITHEK_SOURCE_ID));
    expect(records.map((record) => [record.outcome, record.status])).toEqual([
      ["stored", 200],
      ["not-modified", 304],
    ]);
    expect(records[0]?.headers["content-encoding"]).toBe("gzip");
    expect(records[0]?.feed?.ok).toBe(true);
    const stored = records[0]?.object?.file ?? "";
    for await (const { payload } of readSegmentPayloads(root, stored, records)) {
      expect(payload.equals(feed)).toBe(true);
    }
    const sidecars = await listSidecars(root, MOBILITHEK_SOURCE_ID);
    const onDisk = (
      await Promise.all(sidecars.map((sidecar) => readFile(join(root, sidecar.path), "utf8")))
    ).join("\n");
    for (const text of [onDisk, lines.join("\n")]) {
      expect(text).not.toContain(subscriptionId);
      expect(text).not.toContain(tls.password);
    }
    expect(records[0]?.url).toContain("subscriptionID=redacted");
  });
});
