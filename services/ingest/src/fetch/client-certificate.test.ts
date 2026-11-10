import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../clock.ts";
import { ClientCertificate, loadClientCertificate } from "./client-certificate.ts";
import { type FetchRequest, fetchPayload } from "./http-fetch.ts";
import { createTlsFixtures, type TlsFixtures } from "./tls.test-support.ts";

let tls: TlsFixtures;
let server: Server;
let base: string;
const seen: {
  path: string;
  clientCn: string | null;
  ifModifiedSince?: string | undefined;
  acceptEncoding?: string | undefined;
}[] = [];
const body = Buffer.from("feed bytes ".repeat(5000));
const lastModified = "Thu, 29 Oct 2026 20:00:00 GMT";

function answer(request: IncomingMessage, response: ServerResponse): void {
  const socket = request.socket as TLSSocket;
  const peer = socket.getPeerCertificate();
  const clientCn = socket.authorized && peer?.subject ? String(peer.subject.CN) : null;
  const header = (name: string) => request.headers[name] as string | undefined;
  seen.push({
    path: request.url ?? "",
    clientCn,
    ...(header("if-modified-since") ? { ifModifiedSince: header("if-modified-since") } : {}),
    ...(header("accept-encoding") ? { acceptEncoding: header("accept-encoding") } : {}),
  });
  if (!clientCn) {
    response.writeHead(400).end("no client certificate");
  } else if (request.url === "/bomb") {
    response
      .writeHead(200, { "content-encoding": "gzip" })
      .end(gzipSync(Buffer.alloc(8 * 1024 * 1024)));
  } else if (request.url === "/cut") {
    response.writeHead(200, { "content-length": "100000" });
    response.write(Buffer.alloc(1000));
    setTimeout(() => response.socket?.destroy(), 20);
  } else if (header("if-modified-since") === lastModified) {
    response.writeHead(304, { "last-modified": lastModified, etag: '"v1"' }).end();
  } else {
    const compressed = gzipSync(body);
    response
      .writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
        "last-modified": lastModified,
        etag: '"v1"',
      })
      .end(compressed);
  }
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
    answer,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await tls.cleanup();
});

function request(
  path: string,
  certificate: ClientCertificate | undefined,
  extra: Partial<FetchRequest> = {},
): FetchRequest {
  return {
    url: `${base}${path}`,
    method: "GET",
    headers: { "user-agent": "gerlines/0.1.0 (+test@example.org)" },
    redirect: "manual",
    maxBytes: 1024 * 1024,
    headersTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    sink: { kind: "memory" },
    ...(certificate ? { clientCertificate: certificate } : {}),
    ...extra,
  };
}

async function certificate(path = tls.p12Path): Promise<ClientCertificate> {
  return loadClientCertificate(path, tls.password, { ca: tls.caCert });
}

function thrown(task: () => unknown): Error {
  try {
    task();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("loadClientCertificate", () => {
  it("opens the PKCS#12 file with its password", async () => {
    const loaded = await certificate();
    expect(loaded).toBeInstanceOf(ClientCertificate);
  });

  it("refuses a wrong password without echoing either password", async () => {
    const wrong = "made-up-wrong-password-9876";
    const message = thrown(() => loadClientCertificate(tls.p12Path, wrong)).message;
    expect(message).toMatch(/client certificate/);
    expect(message).not.toContain(wrong);
    expect(message).not.toContain(tls.password);
  });

  it("names a missing file by its path only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "no-cert-"));
    const error = thrown(() => loadClientCertificate(join(dir, "absent.p12"), tls.password));
    await rm(dir, { recursive: true, force: true });
    expect(error.message).toMatch(/absent\.p12/);
    expect(error.message).not.toContain(tls.password);
  });

  it("never shows its password or key bytes when logged or serialised", async () => {
    const loaded = await certificate();
    const pfx = await readFile(tls.p12Path);
    const shown = [
      JSON.stringify({ loaded }),
      inspect(loaded, { showHidden: true, depth: 5 }),
      String(loaded),
    ];
    for (const text of shown) {
      expect(text).not.toContain(tls.password);
      expect(text).not.toContain(pfx.subarray(0, 32).toString("base64"));
    }
  });
});

describe("fetchPayload with a client certificate", () => {
  it("presents the certificate and stores the body after gzip transfer decoding", async () => {
    seen.length = 0;
    const result = await fetchPayload(request("/feed", await certificate()), systemClock);
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(200);
    expect(result.body?.equals(body)).toBe(true);
    expect(result.bytes).toBe(body.length);
    expect(result.headers).toMatchObject({
      "content-encoding": "gzip",
      "last-modified": lastModified,
      etag: '"v1"',
    });
    expect(seen[0]?.clientCn).toBe("gerlines-recorder");
    expect(seen[0]?.acceptEncoding).toMatch(/gzip/);
  });

  it("is answered 400 without a certificate the server trusts", async () => {
    const result = await fetchPayload(
      request("/feed", await certificate(tls.otherP12Path)),
      systemClock,
    );
    expect(result.kind === "response" && result.status).toBe(400);
  });

  it("passes a 304 to a conditional request through without a body", async () => {
    const result = await fetchPayload(
      request("/feed", await certificate(), {
        headers: { "if-modified-since": lastModified },
      }),
      systemClock,
    );
    expect(result.kind === "response" && result.status).toBe(304);
    expect(result.kind === "response" && result.body).toBeUndefined();
  });

  it("limits the decoded size, not only the transferred size", async () => {
    const result = await fetchPayload(request("/bomb", await certificate()), systemClock);
    expect(result.kind === "failure" && result.reason).toBe("too-large");
  });

  it("reports a body cut short of its declared length", async () => {
    const result = await fetchPayload(request("/cut", await certificate()), systemClock);
    expect(result.kind === "failure" && result.reason).toBe("truncated");
  });
});
