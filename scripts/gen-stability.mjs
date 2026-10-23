// STABILITY.md is generated from section 11 of docs/design.md ("Stability policy").
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);

export function stabilityText() {
  const design = readFileSync(new URL("docs/design.md", root), "utf8");
  const start = design.indexOf("## 11. Stability policy");
  const end = design.indexOf("## 12. Prior art");
  if (start < 0 || end < 0) throw new Error("docs/design.md: section 11 not found");
  const body = design.slice(start, end).replace(/^## 11\. Stability policy\s*/, "").trimEnd();
  return `# Stability policy

This file is generated from section 11 of [docs/design.md](docs/design.md) by \`npm run stability\`. Do not edit it by hand.

The key-scheme version literal is exported as \`KEY_SCHEME\` (currently \`"gh1"\`).

${body}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("STABILITY.md", root), stabilityText());
  console.log("STABILITY.md written");
}
