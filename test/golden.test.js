import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listGoldens, readGolden, actualOutput } from "./golden-harness.js";
import * as gh from "../src/index.js";

const dir = fileURLToPath(new URL("./golden/", import.meta.url));
const files = existsSync(dir) ? listGoldens(dir) : [];

for (const file of files) {
  const golden = readGolden(file);
  test(`golden: ${golden.name}`, () => {
    assert.equal(golden.header.keyScheme, gh.KEY_SCHEME);
    const actual = actualOutput(golden, gh.graceholder);
    assert.equal(JSON.stringify(actual), JSON.stringify(golden.output));
  });
}

test("the golden suite is present (at least 5 representative queries)", () => {
  assert.ok(files.length >= 5, `found ${files.length} golden files`);
});

test("golden headers record locale and key scheme", () => {
  for (const file of files) {
    const g = readGolden(file);
    assert.equal(g.header.locale, "en", file);
    assert.equal(g.header.keyScheme, "gh1", file);
    assert.ok(g.output !== null, `${file} has no recorded output (run npm run golden:update)`);
  }
});
