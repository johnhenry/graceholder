// Golden-file harness. A golden file is JSON:
//   { "name", "header": { "locale", "keyScheme" }, "input": { "query", "spec"?, "options"? }, "output" }
// `output` is compared by JSON.stringify equality (byte-identical output).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function listGoldens(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

export function readGolden(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Run a golden's input through `run(query, options)` and return the actual output. */
export function actualOutput(golden, run) {
  const { query, spec, options } = golden.input;
  return run(query, { ...(options ?? {}), ...(spec ? { spec } : {}) });
}

export function serialize(golden) {
  return JSON.stringify(golden, null, 2) + "\n";
}

/** Rewrite every golden in `dir` with the output `run` currently produces. */
export function updateGoldens(dir, run) {
  for (const file of listGoldens(dir)) {
    const g = readGolden(file);
    g.output = actualOutput(g, run);
    writeFileSync(file, serialize(g));
  }
}
