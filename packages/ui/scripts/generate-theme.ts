import { readFileSync, writeFileSync } from "node:fs";
import { fontsCss } from "../src/theme/fonts-css.ts";
import { themeCss } from "../src/theme/theme-css.ts";

function readWeightCss(packageName: string, weight: number): string {
  const file = new URL(`../node_modules/@fontsource/${packageName}/${weight}.css`, import.meta.url);
  return readFileSync(file, "utf8");
}

writeFileSync(new URL("../src/styles/theme.generated.css", import.meta.url), themeCss());
writeFileSync(
  new URL("../src/styles/fonts.generated.css", import.meta.url),
  fontsCss(readWeightCss),
);
