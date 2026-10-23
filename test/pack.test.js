import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("npm pack ships only the intended files", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path).sort();
  const allowed = [/^src\/[\w./-]+$/, /^(README\.md|LICENSE|STABILITY\.md|package\.json)$/];
  for (const f of files) assert.ok(allowed.some((re) => re.test(f)), `unexpected file in the package: ${f}`);
  for (const must of ["package.json", "README.md", "LICENSE", "STABILITY.md", "src/index.js", "src/index.d.ts", "src/vocab/en.js", "src/vocab/PROVENANCE.md", "src/packs/geo.js", "src/packs/geo.d.ts", "src/packs/index.js", "src/packs/PROVENANCE.md"]) {
    assert.ok(files.includes(must), `missing ${must}`);
  }
  assert.ok(!files.some((f) => f.startsWith("test/") || f.startsWith("scripts/") || f.startsWith("docs/") || f.startsWith(".github")));
});
