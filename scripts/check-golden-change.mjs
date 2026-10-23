// A golden file is an output change (docs/design.md section 11). From 1.0.0 on, a PR that changes
// test/golden requires the `breaking` label. Before 1.0.0 goldens may change freely (the PR must
// explain why). Used by .github/workflows/golden-guard.yml.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {{ version: string, changedFiles: string[], labels: string[] }} input
 * @returns {{ ok: boolean, message: string }}
 */
export function evaluate({ version, changedFiles, labels }) {
  const goldens = changedFiles.filter((f) => f.startsWith("test/golden/"));
  if (goldens.length === 0) return { ok: true, message: "no golden file changed" };
  const major = Number(String(version).split(".")[0]);
  if (!(major >= 1)) return { ok: true, message: `pre-1.0 (${version}): ${goldens.length} golden file(s) changed; explain the output change in the PR` };
  if (labels.includes("breaking")) return { ok: true, message: `${goldens.length} golden file(s) changed and the PR is labelled breaking` };
  return { ok: false, message: `${goldens.length} golden file(s) changed (${goldens.join(", ")}) but the PR is not labelled "breaking": a changed golden is an output change and needs a major release` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.BASE_SHA;
  if (!base) throw new Error("BASE_SHA is required");
  const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  const labels = JSON.parse(process.env.PR_LABELS ?? "[]");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const r = evaluate({ version, changedFiles, labels });
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}
