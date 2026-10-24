import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { pkg } from "./browser-support.js";

const src = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));
const PEERS = ["@apollo/client", "@urql/core", "wonka", "rxjs"];

async function bundleOf(entry, { external = [], minify = true } = {}) {
  const r = await build({
    entryPoints: [src(entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify,
    write: false,
    metafile: true,
    external,
    logLevel: "silent",
  });
  return { code: r.outputFiles[0].text, inputs: Object.keys(r.metafile.inputs) };
}

test("the core entry does not pull in any adapter or optional peer", async () => {
  const { code, inputs } = await bundleOf("index.js", { minify: false });
  assert.ok(!inputs.some((i) => i.includes("adapters/")), "no adapter module in the core graph");
  for (const peer of PEERS) {
    assert.ok(!inputs.some((i) => i.includes(`node_modules/${peer}/`)), `${peer} is not bundled into core`);
    assert.ok(!code.includes(`from "${peer}`), `core does not import ${peer}`);
  }
  const packages = new Set(inputs.filter((i) => i.includes("node_modules/")).map((i) => i.split("node_modules/")[1].split("/")[0]));
  assert.deepEqual([...packages], ["graphql"], "graphql is the only package in the core bundle");
});

test("the optional peers are optional peerDependencies and devDependencies; graphql is the only dependency", () => {
  const p = pkg();
  assert.deepEqual(Object.keys(p.dependencies), ["graphql"]);
  for (const peer of ["@apollo/client", "@urql/core", "wonka"]) {
    assert.ok(p.peerDependencies[peer], `${peer} peer`);
    assert.equal(p.peerDependenciesMeta[peer].optional, true, `${peer} optional`);
    assert.ok(p.devDependencies[peer], `${peer} dev`);
  }
});

test("package exports expose ./apollo, ./urql and ./fetch with types", () => {
  const { exports } = pkg();
  for (const name of ["apollo", "urql", "fetch"]) {
    assert.deepEqual(exports[`./${name}`], { types: `./src/adapters/${name}.d.ts`, default: `./src/adapters/${name}.js` });
  }
});

test("each adapter imports only its own peers, and reports its size", async () => {
  // baseline: core with createWorld (what every adapter needs), tree-shaken
  const base = await build({ stdin: { contents: `export { createWorld } from ${JSON.stringify(src("index.js"))}`, resolveDir: src("") }, bundle: true, format: "esm", platform: "browser", minify: true, write: false, logLevel: "silent" });
  const core = gzipSync(base.outputFiles[0].text).length;
  const expected = { apollo: ["@apollo/client"], urql: ["@urql/core", "wonka"], fetch: [] };
  for (const [name, peers] of Object.entries(expected)) {
    const { code, inputs } = await bundleOf(`adapters/${name}.js`, { external: PEERS });
    const imported = PEERS.filter((peer) => new RegExp(`from\\s*"${peer}"|import\\s*"${peer}"`).test(code));
    assert.deepEqual(imported.sort(), [...peers].sort(), name);
    assert.ok(!inputs.some((i) => /node_modules\/(@apollo|@urql|wonka|rxjs)\//.test(i)), `${name}: no peer inlined`);
    const gz = gzipSync(code).length;
    console.log(`# graceholder/${name} (peers external, includes world + graphql): ${code.length} bytes minified, ${gz} bytes gzip (+${gz - core} over createWorld alone)`);
    assert.ok(gz < 140 * 1024, `${name} gzip ${gz}`);
  }
});

test("the fetch adapter bundles for the browser with no peer and no Node built-ins", async () => {
  const { code } = await bundleOf("adapters/fetch.js", { minify: false });
  assert.ok(!/\brequire\(|from ["']node:/.test(code));
});
