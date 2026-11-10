import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsFixtures {
  readonly dir: string;
  readonly caCert: Buffer;
  readonly serverKey: Buffer;
  readonly serverCert: Buffer;
  readonly p12Path: string;
  readonly otherP12Path: string;
  readonly password: string;
  cleanup(): Promise<void>;
}

/**
 * A throwaway CA, a server certificate for 127.0.0.1 and two client certificates as PKCS#12 files (one signed by
 * the CA, one self-signed), made with the openssl CLI. The made-up password reaches openssl through the
 * environment, never through argv.
 */
export async function createTlsFixtures(): Promise<TlsFixtures> {
  const dir = await mkdtemp(join(tmpdir(), "gerlines-tls-"));
  const password = "made-up-p12-password-0123";
  const env = { ...process.env, P12_PASSWORD: password };
  const openssl = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, env, stdio: "pipe" });
  const at = (name: string) => join(dir, name);
  await writeFile(at("server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=gerlines test ca",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "2",
    "-extfile",
    "server.ext",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=gerlines-recorder",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "client.pem",
    "-days",
    "2",
  ]);
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "other.key",
    "-out",
    "other.pem",
    "-days",
    "2",
    "-subj",
    "/CN=stranger",
  ]);
  const pkcs12 = [
    "-keypbe",
    "AES-256-CBC",
    "-certpbe",
    "AES-256-CBC",
    "-macalg",
    "sha256",
    "-passout",
    "env:P12_PASSWORD",
  ];
  openssl([
    "pkcs12",
    "-export",
    "-inkey",
    "client.key",
    "-in",
    "client.pem",
    "-certfile",
    "ca.pem",
    "-out",
    "client.p12",
    ...pkcs12,
  ]);
  openssl([
    "pkcs12",
    "-export",
    "-inkey",
    "other.key",
    "-in",
    "other.pem",
    "-out",
    "other.p12",
    ...pkcs12,
  ]);
  return {
    dir,
    caCert: await readFile(at("ca.pem")),
    serverKey: await readFile(at("server.key")),
    serverCert: await readFile(at("server.pem")),
    p12Path: at("client.p12"),
    otherP12Path: at("other.p12"),
    password,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
