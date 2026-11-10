import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { localDefaults } from "./config.ts";

const repoFile = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
const compose = await repoFile("infra/compose.yaml");
const workflow = await repoFile(".github/workflows/db.yml");
const rootScripts = (
  JSON.parse(await repoFile("package.json")) as { scripts: Record<string, string> }
).scripts;
const liveDockerfile = await repoFile("services/live/Dockerfile");
const liveCli = await repoFile("services/live/src/cli.ts");
const apiConfig = await repoFile("apps/api/src/config.ts");
const envExample = await repoFile(".env.example");

const WORKSPACE_DIRS = ["apps", "packages", "services"] as const;
const workspacePackages = new Map<string, { dir: string; deps: string[] }>();
for (const parent of WORKSPACE_DIRS) {
  for (const entry of await readdir(new URL(`../../../${parent}`, import.meta.url))) {
    let text: string;
    try {
      text = await repoFile(`${parent}/${entry}/package.json`);
    } catch {
      continue;
    }
    const manifest = JSON.parse(text) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name);
    workspacePackages.set(manifest.name, { dir: `${parent}/${entry}`, deps });
  }
}

function workspaceClosure(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const dep of workspacePackages.get(name)?.deps ?? []) workspaceClosure(dep, seen);
  return seen;
}

function composeService(name: string): string {
  const match = new RegExp(
    `^ {2}${name}:\\s*$([\\s\\S]*?)(?=^ {2}[a-z][\\w-]*:\\s*$|^[a-z])`,
    "m",
  ).exec(compose);
  return match?.[1] ?? "";
}

function triggerPaths(event: "push" | "pull_request"): string[] {
  const block =
    new RegExp(`^ {2}${event}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(workflow)?.[1] ?? "";
  const paths = /^ {4}paths:\n((?: {6}- .*\n)+)/m.exec(block)?.[1] ?? "";
  return [...paths.matchAll(/- (\S+)/g)].map((match) => match[1] ?? "");
}

function images(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? "");
}

function pulledImages(yaml: string): string[] {
  return yaml
    .split(/^(?= {2}[a-z][\w-]*:\s*$)/m)
    .filter((service) => !/^\s+build:/m.test(service))
    .flatMap(images);
}

describe("local infrastructure files", () => {
  it.each([
    ["infra/compose.yaml", pulledImages(compose), 3],
    [".github/workflows/db.yml", images(workflow), 1],
  ])("%s pins every pulled image by tag and digest", (_path, refs, count) => {
    expect(refs).toHaveLength(count);
    for (const ref of refs) {
      expect(ref).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    }
  });

  it("runs CI against the same database image as Compose", () => {
    const timescale = (yaml: string) => images(yaml).find((ref) => ref.includes("timescaledb"));
    expect(timescale(workflow)).toBe(timescale(compose));
  });

  it("falls back to the defaults for empty as well as unset Compose variables", () => {
    expect(compose).not.toMatch(/\$\{[A-Z0-9_]+-/);
    const password = /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD(:?-)([^}]*)\}/.exec(compose);
    expect(password?.slice(1)).toEqual([":-", localDefaults.password]);
  });

  it("uses the config defaults for the database user and name", () => {
    expect(compose).toContain(`\${POSTGRES_USER:-${localDefaults.user}}`);
    expect(compose).toContain(`\${POSTGRES_DB:-${localDefaults.database}}`);
    expect(workflow).toContain(`POSTGRES_USER: ${localDefaults.user}\n`);
    expect(workflow).toContain(`POSTGRES_DB: ${localDefaults.database}\n`);
  });
});

describe("local run scripts", () => {
  const profiles = [
    ...new Set([...compose.matchAll(/profiles: \["([a-z-]+)"\]/g)].map((m) => m[1])),
  ];

  it.each(["infra:down", "infra:ps", "infra:logs"])("%s names every Compose profile", (script) => {
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(rootScripts[script]).toContain(`--profile ${profile} `);
    }
  });

  it("infra:up:live waits for the services the live profile needs, not for the live engine", () => {
    const script = rootScripts["infra:up:live"] ?? "";
    expect(script).toMatch(/--wait\b/);
    expect(script).toMatch(/ db valkey centrifugo$/);
    expect(script).not.toMatch(/\blive$/);
  });

  it("live:up starts the live engine without waiting for its health check", () => {
    const script = rootScripts["live:up"] ?? "";
    expect(script).toMatch(/--profile live up -d .*\blive$/);
    expect(script).not.toContain("--wait");
  });
});

describe("ports", () => {
  const apiDefault = Number(/DEFAULT_API_PORT = (\d+)/.exec(apiConfig)?.[1]);
  const live = composeService("live");
  const hostPort = /"127\.0\.0\.1:\$\{LIVE_PORT:-(\d+)\}:(\d+)"/.exec(live);
  const runDefault = Number(/DEFAULT_RUN_PORT = (\d+)/.exec(liveCli)?.[1]);
  const replayDefault = Number(/DEFAULT_REPLAY_PORT = (\d+)/.exec(liveCli)?.[1]);

  it("gives the API, the live engine and its replay server distinct defaults", () => {
    expect(apiDefault).toBe(8787);
    expect(new Set([apiDefault, runDefault, replayDefault]).size).toBe(3);
    expect(Number(hostPort?.[1])).toBe(runDefault);
  });

  it("runs the live container, its health check and its host port on the run default", () => {
    expect(Number(hostPort?.[2])).toBe(runDefault);
    expect(live).toContain(`fetch('http://127.0.0.1:${runDefault}/healthz')`);
    expect(liveDockerfile).toContain(`"--port", "${runDefault}"]`);
  });

  it("lists LIVE_PORT in .env.example", () => {
    expect(envExample).toMatch(/^LIVE_PORT=$/m);
  });
});

describe("database workflow triggers", () => {
  const integrationPackages = [
    ...workflow.matchAll(/pnpm --filter (@gerlines\/[\w-]+) test:integration/g),
  ].map((match) => match[1] ?? "");

  it.each(["push", "pull_request"] as const)(
    "%s paths cover every package whose integration tests run, with its workspace dependencies",
    (event) => {
      const paths = triggerPaths(event);
      expect(integrationPackages.length).toBeGreaterThan(0);
      for (const name of integrationPackages) {
        for (const dep of workspaceClosure(name)) {
          const dir = workspacePackages.get(dep)?.dir;
          expect(dir, dep).toBeDefined();
          expect(paths, `${event} misses ${dep}`).toContain(`${dir}/**`);
        }
      }
    },
  );
});
