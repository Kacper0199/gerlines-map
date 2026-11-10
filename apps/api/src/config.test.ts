import { describe, expect, it } from "vitest";
import {
  buildUserAgent,
  ConfigurationError,
  checkProductionSettings,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  readHost,
  readPort,
} from "./config.ts";

const APP_ENV = { APP_NAME: "gerlines-test", APP_CONTACT: "https://example.org/contact" };

describe("buildUserAgent", () => {
  it("builds the User-Agent from the app name, the package version and the contact", () => {
    expect(buildUserAgent(APP_ENV, "0.4.2")).toBe(
      "gerlines-test/0.4.2 (+https://example.org/contact)",
    );
  });

  it("names the missing variable when the contact or the app name is not set", () => {
    expect(() => buildUserAgent({ APP_NAME: "gerlines-test" }, "0.4.2")).toThrow(
      ConfigurationError,
    );
    expect(() => buildUserAgent({ APP_NAME: "gerlines-test" }, "0.4.2")).toThrow(/APP_CONTACT/);
    expect(() => buildUserAgent({ APP_CONTACT: "https://example.org" }, "0.4.2")).toThrow(
      /APP_NAME/,
    );
  });

  it("treats an empty contact as missing", () => {
    expect(() => buildUserAgent({ ...APP_ENV, APP_CONTACT: "  " }, "0.4.2")).toThrow(/APP_CONTACT/);
  });

  it("reports a contact that cannot go into a header", () => {
    expect(() => buildUserAgent({ ...APP_ENV, APP_CONTACT: "a (b)" }, "0.4.2")).toThrow(
      ConfigurationError,
    );
  });
});

describe("readPort", () => {
  it("uses the documented default when API_PORT is unset, empty or blank", () => {
    expect(DEFAULT_API_PORT).toBe(8787);
    expect(readPort({})).toBe(8787);
    expect(readPort({ API_PORT: "" })).toBe(8787);
    expect(readPort({ API_PORT: "  " })).toBe(8787);
  });

  it("reads a port number", () => {
    expect(readPort({ API_PORT: " 9100 " })).toBe(9100);
    expect(readPort({ API_PORT: "1" })).toBe(1);
    expect(readPort({ API_PORT: "65535" })).toBe(65535);
  });

  it.each(["0", "65536", "-1", "80.5", "8787a", "0x50", "1e3", "abc"])(
    "rejects %s instead of listening on another port",
    (value) => {
      expect(() => readPort({ API_PORT: value })).toThrow(ConfigurationError);
      expect(() => readPort({ API_PORT: value })).toThrow(/API_PORT/);
    },
  );
});

describe("readHost", () => {
  it("listens on loopback when API_HOST is unset, empty or blank", () => {
    expect(DEFAULT_API_HOST).toBe("127.0.0.1");
    expect(readHost({})).toBe("127.0.0.1");
    expect(readHost({ API_HOST: "" })).toBe("127.0.0.1");
    expect(readHost({ API_HOST: "  " })).toBe("127.0.0.1");
  });

  it("reads an IPv4 or IPv6 address, the container's every address included", () => {
    expect(readHost({ API_HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
    expect(readHost({ API_HOST: "::" })).toBe("::");
    expect(readHost({ API_HOST: "172.31.250.20" })).toBe("172.31.250.20");
  });

  it.each(["localhost", "api", "0.0.0.0:8787", "[::]", "256.0.0.1", "http://0.0.0.0"])(
    "rejects %s, which is not an address",
    (value) => {
      expect(() => readHost({ API_HOST: value })).toThrow(ConfigurationError);
      expect(() => readHost({ API_HOST: value })).toThrow(/API_HOST/);
    },
  );
});

describe("checkProductionSettings", () => {
  const PRODUCTION = {
    NODE_ENV: "production",
    APP_NAME: "gerlines",
    APP_CONTACT: "https://example.org/contact",
    API_TRUSTED_PROXIES: "172.31.250.10",
    API_CLOUDFLARE_RANGES: "173.245.48.0/20,2400:cb00::/32",
  };

  it("accepts a production environment with every required setting", () => {
    expect(() => checkProductionSettings(PRODUCTION)).not.toThrow();
  });

  it("asks nothing outside production", () => {
    expect(() => checkProductionSettings({})).not.toThrow();
    expect(() => checkProductionSettings({ NODE_ENV: "development" })).not.toThrow();
    expect(() => checkProductionSettings({ NODE_ENV: "test" })).not.toThrow();
  });

  it.each(["APP_NAME", "APP_CONTACT", "API_TRUSTED_PROXIES", "API_CLOUDFLARE_RANGES"])(
    "refuses to start in production without %s",
    (name) => {
      for (const value of [undefined, "", "  "]) {
        const env = { ...PRODUCTION, [name]: value };
        expect(() => checkProductionSettings(env)).toThrow(ConfigurationError);
        expect(() => checkProductionSettings(env)).toThrow(new RegExp(name));
      }
    },
  );

  it("names every missing setting at once", () => {
    expect(() => checkProductionSettings({ NODE_ENV: " Production " })).toThrow(
      /APP_NAME, APP_CONTACT, API_TRUSTED_PROXIES, API_CLOUDFLARE_RANGES/,
    );
  });

  it.each([
    "0.0.0.0/0",
    "::/0",
    "172.31.250.10,0.0.0.0/0",
    "::ffff:0.0.0.0/00",
    "0.0.0.0/1",
    "10.0.0.0/7",
    "2000::/3",
    "fd00::/15",
  ])("refuses a trusted proxy list %s that trusts a large part of the internet", (value) => {
    const env = { ...PRODUCTION, API_TRUSTED_PROXIES: value };
    expect(() => checkProductionSettings(env)).toThrow(ConfigurationError);
    expect(() => checkProductionSettings(env)).toThrow(/API_TRUSTED_PROXIES/);
  });

  it.each(["0.0.0.0/1", "173.245.48.0/20,104.0.0.0/7", "2400:cb00::/32,2000::/12"])(
    "refuses a Cloudflare range list %s with a prefix wider than any Cloudflare range",
    (value) => {
      const env = { ...PRODUCTION, API_CLOUDFLARE_RANGES: value };
      expect(() => checkProductionSettings(env)).toThrow(ConfigurationError);
      expect(() => checkProductionSettings(env)).toThrow(/API_CLOUDFLARE_RANGES/);
    },
  );

  it("accepts the widest allowed prefixes and single addresses", () => {
    const env = {
      ...PRODUCTION,
      API_TRUSTED_PROXIES: "10.0.0.0/8, fd00::/16, 172.31.250.10, ::1",
      API_CLOUDFLARE_RANGES: "104.16.0.0/13, 2a06:98c0::/29",
    };
    expect(() => checkProductionSettings(env)).not.toThrow();
  });
});
