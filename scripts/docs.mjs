// Executes the ```js examples in the Markdown docs. A ```js block followed directly by a ```json
// block must console.log exactly one value equal to that JSON; `node scripts/docs.mjs --write`
// rewrites the JSON blocks from the real output. test/docs.test.js runs this in check mode.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const DOC_FILES = ["README.md", "docs/api.md", "docs/cookbook.md"];
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = pathToFileURL(join(ROOT, "src", "index.js")).href;
const PACKS = pathToFileURL(join(ROOT, "src", "packs")).href;
const FENCE = /^```(\w+)?[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** @returns {{ lang: string, body: string, start: number, end: number, bodyStart: number, bodyEnd: number }[]} */
export function blocks(markdown) {
  const out = [];
  for (const m of markdown.matchAll(FENCE)) {
    const bodyStart = m.index + m[0].indexOf("\n") + 1;
    out.push({ lang: m[1] ?? "", body: m[2], start: m.index, end: m.index + m[0].length, bodyStart, bodyEnd: bodyStart + m[2].length });
  }
  return out;
}

async function runBlock(code, dir, n) {
  const file = join(dir, `example-${n}.mjs`);
  writeFileSync(
    file,
    code
      .replace(/@johnhenry\/graceholder\/(apollo|urql|fetch)\b/g, (_, name) => pathToFileURL(join(ROOT, "src", "adapters", `${name}.js`)).href)
      .replace(/@johnhenry\/graceholder\/packs\/(\w+)/g, (_, name) => `${PACKS}/${name}.js`)
      .replace(/@johnhenry\/graceholder\/packs(?=["'])/g, `${PACKS}/index.js`)
      .replaceAll("@johnhenry/graceholder", SRC),
  );
  const logged = [];
  const real = console.log;
  console.log = (...args) => logged.push(args[0]);
  try {
    await import(pathToFileURL(file).href);
  } finally {
    console.log = real;
  }
  return logged;
}

/** @returns {Promise<{ file: string, line: number, message: string }[]>} problems (empty when all pass) */
export async function checkDocs({ write = false } = {}) {
  const problems = [];
  const dir = mkdtempSync(join(ROOT, "node_modules", ".gh-docs-")); // inside the repo so optional peers (@apollo/client, ...) resolve;
  let n = 0;
  try {
    for (const rel of DOC_FILES) {
      const path = join(ROOT, rel);
      let text = readFileSync(path, "utf8");
      const list = blocks(text);
      const edits = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.lang !== "js") continue;
        const line = text.slice(0, b.start).split("\n").length;
        const next = list[i + 1];
        const hasOut = next && next.lang === "json" && text.slice(b.end, next.start).trim() === "";
        let logged;
        try {
          logged = await runBlock(b.body, dir, n++);
        } catch (e) {
          problems.push({ file: rel, line, message: `example threw: ${e.stack?.split("\n")[0] ?? e}` });
          continue;
        }
        if (!hasOut) continue;
        if (logged.length !== 1) {
          problems.push({ file: rel, line, message: `expected exactly one console.log for the output block, got ${logged.length}` });
          continue;
        }
        const actual = JSON.parse(JSON.stringify(logged[0]));
        if (write) {
          edits.push([next.bodyStart, next.bodyEnd, JSON.stringify(actual, null, 2) + "\n"]);
        } else if (!isDeepStrictEqual(actual, JSON.parse(next.body))) {
          problems.push({ file: rel, line: line + 1, message: "output block differs from the example's output (run: node scripts/docs.mjs --write)" });
        }
      }
      if (write && edits.length) {
        for (const [s, e, body] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, s) + body + text.slice(e);
        writeFileSync(path, text);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkDocs({ write: process.argv.includes("--write") });
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  process.exit(problems.length ? 1 : 0);
}
