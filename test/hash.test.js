import { test } from "node:test";
import assert from "node:assert/strict";
import { xxh64 } from "../src/xxh64.js";
import { SplitMix64, splitmix64Next, intFrom, Stream } from "../src/rng.js";
import { keyString, keyStream, hashKey } from "../src/key.js";

const enc = new TextEncoder();
const hex = (n) => n.toString(16).padStart(16, "0");

// Vectors from the xxHash reference implementation (cross-checked against
// the xxhash-wasm build of the C reference, seed 0 unless noted).
const XXH64_VECTORS = [
  ["", 0n, "ef46db3751d8e999"],
  ["a", 0n, "d24ec4f1a98c6e5b"],
  ["abc", 0n, "44bc2cf5ad770999"],
  ["Hello, world!", 0n, "f58336a78b6f9476"],
  ["The quick brown fox jumps over the lazy dog", 0n, "0b242d361fda71bc"],
  ["x".repeat(31), 0n, "60dd0d01083b99f0"], // last length handled without the 32-byte loop
  ["x".repeat(32), 0n, "e2df261fc2ec30eb"], // exactly one stripe
  ["x".repeat(33), 0n, "b3fa465f554208a6"],
  ["0123456789".repeat(10), 0n, "f80e7b96315afffa"],
  ["héllo ☃ \u{1D11E}", 0n, "887c270f4461bfd4"], // multi-byte UTF-8
  ["gh1\x1fgraceholder\x1fe\x1fUser\x1f42\x1ffirstName", 0n, "ef55401096fffdfa"],
  ["abc", 1n, "bea9ca8199328908"],
  ["abc", 0xffffffffffffffffn, "28306e589cc02176"],
];

for (const [input, seed, expected] of XXH64_VECTORS) {
  test(`XXH64(${JSON.stringify(input.slice(0, 20))}${input.length > 20 ? "..." : ""}, seed ${seed}) = ${expected}`, () => {
    assert.equal(hex(xxh64(enc.encode(input), seed)), expected);
  });
}

test("XXH64 accepts any Uint8Array view (offset buffers)", () => {
  const big = enc.encode("zzabcz");
  assert.equal(hex(xxh64(big.subarray(2, 5))), "44bc2cf5ad770999");
});

test("SplitMix64 reference sequences", () => {
  const seed0 = ["e220a8397b1dcdaf", "6e789e6aa1b965f4", "06c45d188009454f", "f88bb8a8724c81ec", "1b39896a51a8749b"];
  const s0 = new SplitMix64(0n);
  assert.deepEqual(seed0.map(() => hex(s0.next())), seed0);

  const s1 = new SplitMix64(1234567n);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(() => s1.next()),
    [6457827717110365317n, 3203168211198807973n, 9817491932198370423n, 4593380528125082431n, 16408922859458223821n],
  );
});

test("splitmix64Next is pure over (state)", () => {
  const [a, st] = splitmix64Next(0n);
  assert.equal(hex(a), "e220a8397b1dcdaf");
  assert.equal(st, 0x9e3779b97f4a7c15n);
});

test("float() is in [0,1) with 53 bits", () => {
  const s = new Stream(0n);
  for (let i = 0; i < 1000; i++) {
    const f = s.float();
    assert.ok(f >= 0 && f < 1);
  }
  // the largest possible draw maps below 1
  const max = new Stream(0n);
  max.next = () => 0xffffffffffffffffn;
  assert.equal(max.float(), (2 ** 53 - 1) / 2 ** 53);
  const zero = new Stream(0n);
  zero.next = () => 0n;
  assert.equal(zero.float(), 0);
});

test("int(): inclusive bounds, single-value range, negatives", () => {
  const s = new Stream(7n);
  for (let i = 0; i < 500; i++) {
    const v = s.int(3, 10);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 10);
  }
  assert.equal(s.int(5, 5), 5);
  for (let i = 0; i < 100; i++) {
    const v = s.int(-3, 3);
    assert.ok(v >= -3 && v <= 3);
  }
  const seen = new Set();
  const t = new Stream(99n);
  for (let i = 0; i < 400; i++) seen.add(t.int(0, 3));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test("int(): hi < lo and non-integer bounds are RangeErrors", () => {
  const s = new Stream(1n);
  assert.throws(() => s.int(5, 4), RangeError);
  assert.throws(() => s.int(0.5, 3), RangeError);
  assert.throws(() => s.int(0, 2 ** 60), RangeError);
});

test("int(): rejection sampling (no modulo bias) discards draws in the biased tail", () => {
  // range 3: 2^64 % 3 == 1, so the single value 2^64-1 is rejected
  const seq = [0xffffffffffffffffn, 5n];
  const next = () => seq.shift();
  assert.equal(intFrom(next, 10, 12), 10 + (5 % 3));
  assert.equal(seq.length, 0);
  // an accepted first draw consumes exactly one value
  const seq2 = [7n, 8n];
  assert.equal(intFrom(() => seq2.shift(), 0, 2), 7 % 3);
  assert.equal(seq2.length, 1);
  // power-of-two range never rejects
  const seq3 = [0xffffffffffffffffn];
  assert.equal(intFrom(() => seq3.shift(), 0, 15), 15);
});

test("int(): distribution over a non power-of-two range is flat", () => {
  const s = new Stream(2024n);
  const counts = [0, 0, 0];
  const N = 30000;
  for (let i = 0; i < N; i++) counts[s.int(0, 2)]++;
  for (const c of counts) assert.ok(Math.abs(c / N - 1 / 3) < 0.02, String(counts));
});

test("pick(), weighted(), bool()", () => {
  const s = new Stream(5n);
  const arr = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) assert.ok(arr.includes(s.pick(arr)));
  assert.throws(() => s.pick([]), RangeError);
  assert.equal(s.pick(["only"]), "only");

  const w = new Stream(6n);
  const counts = { x: 0, y: 0 };
  for (let i = 0; i < 4000; i++) counts[w.weighted([["x", 1], ["y", 3]])]++;
  assert.ok(counts.y > counts.x * 2 && counts.y < counts.x * 4, JSON.stringify(counts));
  assert.throws(() => w.weighted([]), RangeError);
  assert.throws(() => w.weighted([["x", 0]]), RangeError);

  const b = new Stream(8n);
  assert.equal(b.bool(0), false);
  assert.equal(b.bool(1), true);
});

test("a Stream is a local, repeatable sequence", () => {
  const a = new Stream(123n);
  const b = new Stream(123n);
  assert.deepEqual([a.next(), a.next(), a.int(0, 9)], [b.next(), b.next(), b.int(0, 9)]);
});

// --- key string -------------------------------------------------------------

test("keyString: frozen scheme gh1, 0x1F separator", () => {
  assert.equal(
    keyString({ seed: "graceholder", scope: "e", typeName: "User", entityKey: "42", fieldName: "firstName" }),
    "gh1\x1fgraceholder\x1fe\x1fUser\x1f42\x1ffirstName",
  );
});

test("keyString: sub-keys appended in order, numbers stringified", () => {
  assert.equal(
    keyString({ seed: 7, scope: "l", typeName: "Query", entityKey: "Query", fieldName: "users", subKeys: [0, "x"] }),
    "gh1\x1f7\x1fl\x1fQuery\x1fQuery\x1fusers\x1f0\x1fx",
  );
});

test("keyString: 0x1F inside user text becomes U+FFFD", () => {
  assert.equal(
    keyString({ seed: "a\x1fb", scope: "a", typeName: "T", entityKey: "k\x1f", fieldName: "f" }),
    "gh1\x1fa�b\x1fa\x1fT\x1fk�\x1ff",
  );
});

test("keyString: rejects unknown scopes", () => {
  assert.throws(() => keyString({ seed: "s", scope: "z", typeName: "T", entityKey: "1", fieldName: "f" }), RangeError);
});

test("hashKey/keyStream: key snapshot (frozen output)", () => {
  const parts = { seed: "graceholder", scope: "e", typeName: "User", entityKey: "42", fieldName: "firstName" };
  assert.equal(hex(hashKey(parts)), "ef55401096fffdfa");
  const s = keyStream(parts);
  const first = s.next();
  assert.equal(first, new SplitMix64(0xef55401096fffdfan).next());
  // different seed / entity / field / type / scope differ
  const base = hashKey(parts);
  for (const change of [{ seed: "other" }, { entityKey: "43" }, { fieldName: "lastName" }, { typeName: "Admin" }, { scope: "p" }]) {
    assert.notEqual(hashKey({ ...parts, ...change }), base, JSON.stringify(change));
  }
});
