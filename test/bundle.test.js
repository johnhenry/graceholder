import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
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
  const code = await bundle({ minify: true, packs: false });
  const gz = gzipSync(code).length;
  console.log(`# graceholder + graphql, minified: ${code.length} bytes, gzip: ${gz} bytes`);
  assert.ok(gz < 120 * 1024, `gzip size ${gz}`);
});

test("each vocabulary pack is a separate, small module; the core does not contain pack data", async () => {
  const core = await bundle({ minify: true, packs: false });
  assert.ok(!core.includes("Wibblefern") && !core.includes("Tidewell") && !core.includes("Johannesburg") && !core.includes("Marlow Grocers"), "core must not ship pack vocabulary");
  const sizes = {};
  for (const name of ["geo", "commerce", "finance", "health"]) {
    const r = await build({
      entryPoints: [fileURLToPath(new URL(`../src/packs/${name}.js`, import.meta.url))],
      bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, write: false, logLevel: "silent",
    });
    const text = r.outputFiles[0].text;
    sizes[name] = { min: text.length, gzip: gzipSync(text).length };
  }
  console.log(`# packs (minified / gzip bytes): ${Object.entries(sizes).map(([k, v]) => `${k} ${v.min}/${v.gzip}`).join(", ")}`);
  for (const [name, v] of Object.entries(sizes)) assert.ok(v.gzip < 8 * 1024, `${name} pack gzip ${v.gzip}`);
  const all = await bundle({ minify: true, packs: true });
  console.log(`# graceholder + graphql + all packs, minified: ${all.length} bytes, gzip: ${gzipSync(all).length} bytes`);
});
