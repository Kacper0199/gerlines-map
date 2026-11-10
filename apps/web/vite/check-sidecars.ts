import { resolve } from "node:path";
import { staleSidecars } from "./precompress-plugin.ts";

const stale = await staleSidecars(resolve(process.argv[2] ?? "dist"));
if (stale.length > 0) {
  process.stdout.write(`${stale.join("\n")}\n`);
  process.exitCode = 1;
}
