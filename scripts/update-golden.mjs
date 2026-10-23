// Rewrites test/golden/*.json with current output. Review the diff: any change
// to a golden file is an output change (docs/design.md section 11).
import { fileURLToPath } from "node:url";
import { updateGoldens } from "../test/golden-harness.js";
import { graceholder, registerPack } from "../src/index.js";
import { allPacks } from "../src/packs/index.js";

for (const pack of allPacks) registerPack(pack);

updateGoldens(fileURLToPath(new URL("../test/golden/", import.meta.url)), graceholder);
console.log("goldens updated");
