import { readFileSync } from "node:fs";
import { categoryOfLeg } from "../src/router/categories.ts";

const legs = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(legs)) {
  process.stderr.write("usage: a JSON array of legs ({routeType, mode, displayName}) on stdin\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(legs.map((leg) => categoryOfLeg(leg)))}\n`);
