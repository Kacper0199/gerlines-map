import { describe, expect, it } from "vitest";
import {
  isLoopbackDatabaseUrl,
  localDefaults,
  parseDatabaseUrl,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  withDatabase,
} from "./config.ts";

const passwordKey = "POSTGRES_PASSWORD";
const localPassword = localDefaults.password;
const samplePassword = ["sample", "pass", "phrase"].join("-");

describe("resolveDatabaseUrl", () => {
  it("defaults to the local Compose database", () => {
    expect(resolveDatabaseUrl({})).toBe(
      `postgres://gerlines:${localPassword}@127.0.0.1:5433/gerlines`,
    );
  });

  it("builds the URL from the POSTGRES variables", () => {
    expect(
      resolveDatabaseUrl({
        POSTGRES_HOST: "db",
        POSTGRES_PORT: "5432",
        POSTGRES_USER: "rec",
        [passwordKey]: samplePassword,
        POSTGRES_DB: "trains",
      }),
    ).toBe(`postgres://rec:${samplePassword}@db:5432/trains`);
  });

  it("percent-encodes reserved characters in credentials and database name", () => {
    const reserved = `${samplePassword}@:/`;
    const url = new URL(resolveDatabaseUrl({ [passwordKey]: reserved, POSTGRES_DB: "a b" }));
    expect(url.password).toBe(`${samplePassword}%40%3A%2F`);
    expect(decodeURIComponent(url.password)).toBe(reserved);
    expect(url.pathname).toBe("/a%20b");
  });

  it("treats empty and blank variables as unset", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: " ", POSTGRES_PORT: "", POSTGRES_USER: " " })).toBe(
      resolveDatabaseUrl({}),
    );
  });

  it("prefers DATABASE_URL over the POSTGRES variables", () => {
    const explicit = `postgresql://u:${samplePassword}@h:6000/d`;
    expect(resolveDatabaseUrl({ DATABASE_URL: explicit, POSTGRES_PORT: "1" })).toBe(explicit);
  });

  it("rejects a DATABASE_URL with another scheme", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "mysql://h/d" })).toThrow(
      /postgres:\/\/ or postgresql:\/\//,
    );
  });
});

describe("parseDatabaseUrl", () => {
  it("rejects text that is not a URL without echoing it", () => {
    expect(() => parseDatabaseUrl("not a url with secret")).toThrow(
      /^database URL is not a valid URL$/,
    );
  });

  it("rejects a URL without a database name", () => {
    expect(() => parseDatabaseUrl("postgres://127.0.0.1:5433/")).toThrow(/must name a database/);
  });

  it.each([
    "host=db.example.org",
    "hostaddr=203.0.113.7",
    "port=6000",
    "HOST=db.example.org",
    "sslmode=require&host=db.example.org",
  ])("rejects the query parameter in ?%s that would override the address", (query) => {
    expect(() => parseDatabaseUrl(`postgres://u@127.0.0.1:5433/d?${query}`)).toThrow(
      /^database URL must not set host, hostaddr or port as a query parameter$/,
    );
  });

  it("keeps other query parameters", () => {
    expect(parseDatabaseUrl("postgres://u@127.0.0.1:5433/d?sslmode=require").search).toBe(
      "?sslmode=require",
    );
  });
});

describe("withDatabase", () => {
  it("replaces only the database name", () => {
    expect(
      withDatabase(`postgres://u:${samplePassword}@127.0.0.1:5433/gerlines`, "gerlines_test_1"),
    ).toBe(`postgres://u:${samplePassword}@127.0.0.1:5433/gerlines_test_1`);
  });
});

describe("isLoopbackDatabaseUrl", () => {
  it.each([
    ["postgres://127.0.0.1:5433/d", true],
    ["postgres://localhost:5433/d", true],
    ["postgres://[::1]:5433/d", true],
    ["postgres://db.example.org:5432/d", false],
    ["postgres://10.0.0.5:5432/d", false],
    ["postgres://127.0.0.1.example.org:5432/d", false],
  ])("%s is loopback: %s", (url, expected) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(expected);
  });

  it("refuses a loopback URL whose query parameter points elsewhere", () => {
    expect(() =>
      isLoopbackDatabaseUrl("postgres://u@127.0.0.1:5433/d?host=db.example.org"),
    ).toThrow(/must not set host, hostaddr or port/);
  });
});

describe("redactDatabaseUrl", () => {
  it("hides the password", () => {
    const marker = "redacted";
    expect(redactDatabaseUrl(`postgres://u:${samplePassword}@h:5433/d`)).toBe(
      `postgres://u:${marker}@h:5433/d`,
    );
  });

  it("hides secret query parameters and keeps the others", () => {
    const query = [
      `password=${samplePassword}`,
      `sslpassword=${samplePassword}`,
      "sslkey=%2Fkeys%2Fclient.key",
      "sslcert=%2Fkeys%2Fclient.crt",
      "sslmode=verify-full",
    ].join("&");
    const redacted = redactDatabaseUrl(`postgres://u@h:5433/d?${query}`);
    expect(redacted).not.toContain(samplePassword);
    expect(redacted).not.toContain("client.key");
    expect(new URL(redacted).searchParams.toString()).toBe(
      "password=redacted&sslpassword=redacted&sslkey=redacted&sslcert=redacted&sslmode=verify-full",
    );
  });

  it("leaves a URL without password unchanged", () => {
    expect(redactDatabaseUrl("postgres://u@h:5433/d")).toBe("postgres://u@h:5433/d");
  });
});
