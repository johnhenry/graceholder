// Heavy bulk tests: 100k rows through stream() and a large SQL load.
// Skip them in quick local runs with GRACEHOLDER_QUICK=1; CI runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stream, toNDJSON, toSQL } from "../src/index.js";

const heavy = process.env.GRACEHOLDER_QUICK ? { skip: "GRACEHOLDER_QUICK is set" } : { timeout: 120_000 };
const MB = 1024 * 1024;

test("stream() of 100k rows keeps memory bounded and finishes in reasonable time", heavy, () => {
  const q = `{ users { id name email } }`;
  const N = 100_000;
  const s = stream(q, { seed: "heavy", count: N });
  // warm up: compile-time and one window of work are not growth
  const it = s[Symbol.iterator]();
  for (let i = 0; i < 1000; i++) it.next();
  globalThis.gc?.();
  const base = process.memoryUsage().heapUsed;
  let peak = 0;
  let n = 1000;
  let last;
  const started = process.hrtime.bigint();
  for (let r = it.next(); !r.done; r = it.next()) {
    n++;
    last = r.value;
    if (n % 2500 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - base);
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(n, N);
  assert.equal(last.id, String(N));
  console.log(`# 100k rows: ${seconds.toFixed(1)}s, peak heapUsed growth ${(peak / MB).toFixed(1)} MB`);
  // Materialising 100k such rows costs well over 100 MB; a lazy stream stays far below. Generous threshold:
  assert.ok(peak < 120 * MB, `heapUsed grew by ${(peak / MB).toFixed(1)} MB`);
  assert.ok(seconds < 60, `took ${seconds.toFixed(1)}s`);
});

test("NDJSON of 100k rows streams without holding the output", heavy, () => {
  const N = 100_000;
  let bytes = 0;
  let lines = 0;
  let peak = 0;
  const base = process.memoryUsage().heapUsed;
  for (const line of toNDJSON(stream(`{ users { id name } }`, { seed: "heavy", count: N }))) {
    bytes += line.length;
    if (++lines % 5000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - base);
  }
  assert.equal(lines, N);
  assert.ok(bytes > N * 20);
  assert.ok(peak < 120 * MB, `heapUsed grew by ${(peak / MB).toFixed(1)} MB`);
});

const DatabaseSync = await import("node:sqlite").then((m) => m.DatabaseSync, () => null);

test("SQL of 20k rows with references loads into node:sqlite with no duplicate keys", DatabaseSync ? heavy : { skip: "node:sqlite is not available" }, () => {
  const db = new DatabaseSync(":memory:");
  const q = `{ posts { id title author { id name } comments @count(n: 2) { id body } } }`;
  const N = 20_000;
  let peak = 0;
  const base = process.memoryUsage().heapUsed;
  let i = 0;
  for (const chunk of toSQL(q, { seed: "heavy", count: N, dialect: "sqlite", transaction: false })) {
    db.exec(chunk);
    if (++i % 2000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - base);
  }
  assert.equal(db.prepare("select count(*) n from post").get().n, N);
  assert.equal(db.prepare("select count(*) n from comment").get().n, N * 2);
  assert.equal(db.prepare("select count(*) n from author").get().n <= 100, true);
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  assert.ok(peak < 200 * MB, `heapUsed grew by ${(peak / MB).toFixed(1)} MB`);
  db.close();
});
