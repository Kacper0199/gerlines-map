import { parseArgs } from "node:util";
import { generateTypes } from "./codegen.ts";
import { isLoopbackDatabaseUrl, redactDatabaseUrl, resolveDatabaseUrl } from "./config.ts";
import {
  getStatus,
  type MigrationResult,
  migrateDown,
  migrateDownAll,
  migrateUp,
} from "./runner.ts";

const usage = `Usage: node src/cli.ts <command> [options]

Commands:
  migrate [--to <version>]   apply pending migrations, optionally up to a version
  rollback [--steps <n>]     revert the newest applied migrations (default 1)
  status                     list migrations and whether each is applied
  reset                      revert every migration, then apply all (loopback databases only)
  types [--verify]           regenerate src/generated/database.ts, or check it is current

The database comes from DATABASE_URL, or POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER,
POSTGRES_PASSWORD and POSTGRES_DB with the local Compose defaults.
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printResults(direction: "up" | "down", results: MigrationResult[]): void {
  if (results.length === 0) {
    print(direction === "up" ? "nothing to apply" : "nothing to revert");
    return;
  }
  const verb = direction === "up" ? "applied" : "reverted";
  for (const { version, name, durationMs } of results) {
    print(`${verb} ${String(version).padStart(4, "0")} ${name} (${durationMs} ms)`);
  }
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got ${value}`);
  }
  return parsed;
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      steps: { type: "string" },
      verify: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command === undefined) {
    print(usage);
    return;
  }

  const databaseUrl = resolveDatabaseUrl(process.env);
  print(`database ${redactDatabaseUrl(databaseUrl)}`);

  switch (command) {
    case "migrate": {
      const targetVersion = positiveInteger(values.to, "--to");
      printResults(
        "up",
        await migrateUp(
          targetVersion === undefined ? { databaseUrl } : { databaseUrl, targetVersion },
        ),
      );
      return;
    }
    case "rollback": {
      const steps = positiveInteger(values.steps, "--steps") ?? 1;
      printResults("down", await migrateDown({ databaseUrl, steps }));
      return;
    }
    case "status": {
      for (const { version, name, state } of await getStatus({ databaseUrl })) {
        print(`${String(version).padStart(4, "0")} ${name.padEnd(24)} ${state}`);
      }
      return;
    }
    case "reset": {
      if (!isLoopbackDatabaseUrl(databaseUrl)) {
        throw new Error("reset only runs against a database on 127.0.0.1, localhost or ::1");
      }
      printResults("down", await migrateDownAll({ databaseUrl }));
      printResults("up", await migrateUp({ databaseUrl }));
      return;
    }
    case "types": {
      await generateTypes({ databaseUrl, verify: values.verify });
      print(values.verify ? "types are up to date" : "types written");
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${usage}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
