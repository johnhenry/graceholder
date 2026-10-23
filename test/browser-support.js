// Shared helpers for the bundle and browser tests: build the library as one browser script
// and run every golden through a given evaluator.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { listGoldens, readGolden } from "./golden-harness.js";
import { fileURLToPath } from "node:url";

export const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

export async function bundle({ minify = false } = {}) {
  const r = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
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
