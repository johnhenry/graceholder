// Shared helpers for the bundle and browser tests: build the library as one browser script
// and run every golden through a given evaluator.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { listGoldens, readGolden } from "./golden-harness.js";
import { fileURLToPath } from "node:url";

export const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

/**
 * The library as one browser script. With `packs` (default) every vocabulary pack is bundled and
 * registered, because goldens name packs by string; the size report uses `packs: false`.
 */
export async function bundle({ minify = false, packs = true } = {}) {
  const index = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const packIndex = fileURLToPath(new URL("../src/packs/index.js", import.meta.url));
  const r = await build({
    stdin: {
      contents: packs
        ? `export * from ${JSON.stringify(index)};\nimport { registerPack } from ${JSON.stringify(index)};\nimport { allPacks } from ${JSON.stringify(packIndex)};\nfor (const p of allPacks) registerPack(p);`
        : `export * from ${JSON.stringify(index)};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName: "Graceholder",
    platform: "browser",
    target: "es2022",
    minify,
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

export function goldens() {
  return listGoldens(GOLDEN_DIR).map((f) => readGolden(f));
}

/** The call a runtime makes for one golden: `Graceholder.graceholder(query, options)`. */
export function callFor(golden) {
  const { query, spec, options } = golden.input;
  return { query, options: { ...(options ?? {}), ...(spec ? { spec } : {}) } };
}

export const pkg = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
