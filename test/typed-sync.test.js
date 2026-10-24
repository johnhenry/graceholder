import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render } from "../scripts/gen-generator-types.mjs";

test("src/generator-types.d.ts is generated from the runtime catalogue", () => {
  assert.equal(readFileSync(new URL("../src/generator-types.d.ts", import.meta.url), "utf8"), render());
});
