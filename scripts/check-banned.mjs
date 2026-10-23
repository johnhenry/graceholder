// Fails when src/ reads a clock, a random source, the environment or the host
// locale. Determinism guard from docs/design.md section 8.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const BANNED = [
  [/Math\s*\.\s*random\b/, "Math.random"],
  [/Date\s*\.\s*now\b/, "Date.now"],
  [/new\s+Date\s*\(\s*\)/, "new Date()"],
  [/performance\s*\.\s*now\b/, "performance.now"],
  [/\bgetRandomValues\b/, "crypto.getRandomValues"],
  [/\brandomUUID\b/, "crypto.randomUUID"],
  [/\brandomBytes\b/, "randomBytes"],
  [/process\s*\.\s*env\b/, "process.env"],
  [/\btoLocale\w*\s*\(/, "toLocale*()"],
  [/\bIntl\s*\./, "Intl"],
  // engines may differ in the last bit of these; src/detmath.js builds what is needed from + - * /
  [/\bMath\s*\.\s*(exp|expm1|log|log1p|log2|log10|pow|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\b/, "Math.<transcendental>"],
];

/** Remove block comments and line comments (a `//` preceded by whitespace or at line start). */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** @returns {{line:number, token:string}[]} */
export function findBanned(source) {
  const lines = stripComments(source).split("\n");
  const hits = [];
  lines.forEach((text, i) => {
    for (const [re, token] of BANNED) if (re.test(text)) hits.push({ line: i + 1, token });
  });
  return hits;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|cjs|ts)$/.test(name)) out.push(p);
  }
  return out;
}

export function checkDir(dir) {
  const problems = [];
  for (const file of walk(dir)) {
    for (const h of findBanned(readFileSync(file, "utf8"))) {
      problems.push(`${relative(process.cwd(), file)}:${h.line}: banned in src: ${h.token}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const problems = checkDir(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("src/ is free of clock, random, env and locale reads");
}
