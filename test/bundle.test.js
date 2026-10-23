import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { bundle, goldens, callFor } from "./browser-support.js";

test("the library bundles for the browser with no Node built-ins", async () => {
  const code = await bundle();
  assert.ok(!/\brequire\(|from ["']node:|process\.binding/.test(code), "bundle must not reference Node modules");
});

test("a browser-like context (no process, require or Buffer) reproduces every golden byte for byte", async () => {
  const code = await bundle();
  // only ECMAScript built-ins plus the Web APIs a browser has
  const context = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, URL, console });
  vm.runInContext(code, context);
  assert.equal(vm.runInContext("typeof process + typeof require + typeof Buffer + typeof module", context), "undefinedundefinedundefinedundefined");
  const list = goldens();
  assert.ok(list.length >= 5);
  for (const g of list) {
    const { query, options } = callFor(g);
    context.__q = query;
    context.__o = JSON.parse(JSON.stringify(options));
    const out = vm.runInContext("JSON.stringify(Graceholder.graceholder(__q, __o))", context);
    assert.equal(out, JSON.stringify(g.output), g.name);
  }
});

test("bundle size (minified, gzipped) stays modest and is reported", async () => {
  const code = await bundle({ minify: true });
  const gz = gzipSync(code).length;
  console.log(`# graceholder + graphql, minified: ${code.length} bytes, gzip: ${gz} bytes`);
  assert.ok(gz < 120 * 1024, `gzip size ${gz}`);
});
