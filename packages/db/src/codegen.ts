import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import { PostgresDialect as CodegenPostgresDialect, generate, Logger } from "kysely-codegen";
import pg from "pg";

export const generatedTypesFile = fileURLToPath(
  new URL("./generated/database.ts", import.meta.url),
);

export interface GenerateTypesOptions {
  databaseUrl: string;
  outFile?: string;
  verify?: boolean;
}

export async function generateTypes(options: GenerateTypesOptions): Promise<string> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: options.databaseUrl,
        application_name: "gerlines-codegen",
        max: 1,
      }),
    }),
  });
  try {
    return await generate({
      db,
      dialect: new CodegenPostgresDialect(),
      includePattern: "public.*",
      excludePattern: "public.{spatial_ref_sys,geometry_columns,geography_columns}",
      outFile: options.outFile ?? generatedTypesFile,
      verify: options.verify ?? false,
      logger: new Logger("error"),
    });
  } finally {
    await db.destroy();
  }
}
