import { mkdirSync, writeFileSync } from "node:fs";
import { goldenVectors } from "../test/vectors.ts";

const directory = new URL("../test-vectors/", import.meta.url);
mkdirSync(directory, { recursive: true });

const index = goldenVectors().map(({ bytes, ...vector }) => {
  writeFileSync(new URL(`${vector.name}.bin`, directory), bytes);
  writeFileSync(
    new URL(`${vector.name}.json`, directory),
    `${JSON.stringify({ ...vector, byteLength: bytes.length }, null, 2)}\n`,
  );
  return vector.name;
});
writeFileSync(new URL("index.json", directory), `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`${index.length} vectors written to ${directory.pathname}\n`);
