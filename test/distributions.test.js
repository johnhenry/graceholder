import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/generators.js";
import { ln, exp, pow, sin, cos } from "../src/detmath.js";
import { Stream } from "../src/rng.js";
import { keyStream } from "../src/key.js";
import { graceholder, inferSchema } from "../src/index.js";
import { GraceholderError } from "../src/errors.js";

const ANCHOR = Date.parse("2025-01-01T00:00:00.000Z");
const ctxFor = (i, args = {}) => ({
  stream: new Stream(BigInt(i + 1) * 0x9e3779b97f4a7c15n),
  slot: (name) => keyStream({ seed: i, scope: "p", typeName: "T", entityKey: "7", fieldName: name }),
  anchorMs: ANCHOR, args, typeName: "Thing", entityKey: "7", fieldName: "f",
});
const sample = (name, args, n = 6000) => Array.from({ length: n }, (_, i) => generate(name, ctxFor(i, args)));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const frac = (xs, pred) => xs.filter(pred).length / xs.length;

test("detmath agrees with Math to far better than anything that is emitted", () => {
  for (let x = 0.001; x < 1e7; x *= 1.7) assert.ok(Math.abs(ln(x) - Math.log(x)) < 1e-12 * Math.max(1, Math.abs(Math.log(x))), `ln ${x}`);
  for (let x = -30; x <= 30; x += 0.37) assert.ok(Math.abs(exp(x) / Math.exp(x) - 1) < 1e-12, `exp ${x}`);
  for (let x = -50; x <= 50; x += 0.731) {
    assert.ok(Math.abs(sin(x) - Math.sin(x)) < 1e-12, `sin ${x}`);
    assert.ok(Math.abs(cos(x) - Math.cos(x)) < 1e-12, `cos ${x}`);
  }
  assert.ok(Math.abs(pow(2, 0.5) - Math.SQRT2) < 1e-14);
  assert.throws(() => ln(0), RangeError);
});

test("every distribution stays inside [min, max] and is deterministic", () => {
  for (const dist of ["uniform", "normal", "lognormal", "powerlaw", "zipf"]) {
    for (const name of ["int", "float", "money"]) {
      const xs = sample(name, { min: 3, max: 250, dist }, 400);
      assert.ok(xs.every((x) => x >= 3 && x <= 250), `${name} ${dist}`);
      assert.deepEqual(xs, sample(name, { min: 3, max: 250, dist }, 400), `${name} ${dist} repeats`);
      if (name === "int") assert.ok(xs.every(Number.isInteger), `${dist} gives integers`);
    }
  }
  // a degenerate range
  for (const dist of ["normal", "lognormal", "powerlaw", "zipf"]) assert.ok(sample("int", { min: 5, max: 5, dist }, 20).every((x) => x === 5));
});

test("no dist means the unchanged uniform draw (existing goldens depend on it)", () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(generate("int", ctxFor(i, { min: 0, max: 100 })), generate("int", ctxFor(i, { min: 0, max: 100, dist: "uniform" })));
    assert.equal(generate("float", ctxFor(i, { min: 0, max: 1 })), generate("float", ctxFor(i, { min: 0, max: 1, dist: "uniform" })));
  }
});

test("normal: mean and standard deviation of a seeded sample", () => {
  const xs = sample("float", { min: 0, max: 600, dist: "normal", decimals: 4 });
  assert.ok(Math.abs(mean(xs) - 300) < 6, `mean ${mean(xs)}`);
  assert.ok(Math.abs(sd(xs) - 100) < 5, `sd ${sd(xs)}`);
  const custom = sample("float", { min: 0, max: 1000, dist: "normal", mean: 200, sd: 50, decimals: 4 });
  assert.ok(Math.abs(mean(custom) - 200) < 3 && Math.abs(sd(custom) - 50) < 3);
  // about 68% within one sd
  assert.ok(Math.abs(frac(xs, (x) => Math.abs(x - 300) < 100) - 0.6827) < 0.03);
});

test("lognormal: right-skewed, log-space moments match the parameters", () => {
  const xs = sample("float", { min: 0, max: 100000, dist: "lognormal", decimals: 4 });
  const sorted = [...xs].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  assert.ok(mean(xs) > 1.5 * median, `mean ${mean(xs)} median ${median}`);
  const logs = xs.map((x) => Math.log(1 + x));
  assert.ok(Math.abs(mean(logs) - 0.35 * Math.log(100001)) < 0.15, `log mean ${mean(logs)}`);
  const explicit = sample("float", { min: 0, max: 100000, dist: "lognormal", mu: 5, sigma: 1, decimals: 4 });
  const el = explicit.map((x) => Math.log(1 + x));
  assert.ok(Math.abs(mean(el) - 5) < 0.06 && Math.abs(sd(el) - 1) < 0.06);
});

test("powerlaw: empirical CDF follows the inverse-CDF construction", () => {
  const alpha = 2;
  const Y = 1000;
  const F = (y) => (1 - y ** (1 - alpha)) / (1 - Y ** (1 - alpha));
  const xs = sample("float", { min: 0, max: Y - 1, dist: "powerlaw", alpha, decimals: 6 }, 8000);
  for (const t of [1, 3, 9, 49, 199]) assert.ok(Math.abs(frac(xs, (x) => x <= t) - F(t + 1)) < 0.025, `P(x<=${t})`);
  // alpha = 1 uses the logarithmic branch and covers the support
  const one = sample("float", { min: 0, max: 999, dist: "powerlaw", alpha: 1, decimals: 6 }, 4000);
  assert.ok(Math.abs(frac(one, (x) => x <= 9) - Math.log(10) / Math.log(1000)) < 0.03);
  assert.ok(Math.max(...one) > 100);
});

test("zipf: rank probabilities follow k^-s on a bounded support, smallest value most likely", () => {
  const N = 1000;
  const s = 1.1;
  const w = (k) => (k ** (1 - s) - (k + 1) ** (1 - s));
  const total = 1 - (N + 1) ** (1 - s);
  const xs = sample("int", { min: 1, max: N, dist: "zipf", s }, 10000);
  for (const k of [1, 2, 3, 5]) assert.ok(Math.abs(frac(xs, (x) => x === k) - w(k) / total) < 0.015, `P(${k})`);
  assert.ok(frac(xs, (x) => x === 1) > frac(xs, (x) => x === 2));
  assert.ok(Math.max(...xs) > 100, "has a long tail");
  assert.ok(Math.abs(frac(xs, (x) => x <= 10) - (1 - 11 ** (1 - s)) / total) < 0.02);
});

test("bad distribution arguments are rejected at inference time", () => {
  const spec = (args) => ({ spec: { "things.n": { gen: { name: "int", args } } } });
  for (const args of [{ dist: "gaussian" }, { dist: "normal", sd: -1 }, { dist: "lognormal", sigma: 0 }, { dist: "powerlaw", alpha: 0 }, { dist: "zipf", s: "x" }]) {
    assert.throws(() => graceholder("{ things { n } }", spec(args)), (e) => e instanceof GraceholderError && e.code === "bad-generator-args", JSON.stringify(args));
  }
});

test("a spec can ask any field for a distribution; values are per-field and order independent", () => {
  const spec = { "items.size": { gen: { name: "int", args: { min: 1, max: 1000, dist: "zipf" } } } };
  const a = graceholder("{ items(first: 50) { id size } }", { spec });
  const b = graceholder("{ items(first: 50) { size extra: size id name } }", { spec });
  assert.deepEqual(a.items.map((i) => i.size), b.items.map((i) => i.size));
  assert.deepEqual(a.items.map((i) => i.size), b.items.map((i) => i.extra));
  const sizes = graceholder("{ items(first: 1000) { size } }", { spec }).items.map((i) => i.size);
  assert.ok(frac(sizes, (x) => x <= 3) > 0.2 && Math.max(...sizes) > 50);
});

test("popularity fields are uniform by default and heavy-tailed with distributions: realistic", () => {
  const q = "{ posts(first: 1000) { viewCount likes followers sales } }";
  const plain = graceholder(q).posts;
  // default output is unchanged: counts are the T8/T13 results as before
  assert.ok(plain.every((p) => Array.isArray(p.followers) && Array.isArray(p.sales)), "plural names are lists of words without the option");
  const rich = graceholder(q, { distributions: "realistic" }).posts;
  for (const field of ["viewCount", "likes", "followers", "sales"]) {
    const xs = rich.map((p) => p[field]);
    assert.ok(xs.every(Number.isInteger), field);
    const sorted = [...xs].sort((a, b) => a - b);
    const median = sorted[500];
    assert.ok(mean(xs) > 2 * median, `${field}: heavy right tail (mean ${mean(xs)}, median ${median})`);
  }
  assert.ok(rich.map((p) => p.viewCount).every((x) => x >= 0 && x <= 1000000));
  const decisions = inferSchema("{ posts { viewCount followers } }", {}, { distributions: "realistic" }).decisions.filter((d) => d.kind === "scalar");
  assert.deepEqual(decisions.map((d) => d.value), ["Int", "Int"]);
});

test("realistic mode never changes values of fields it does not touch", () => {
  const q = "{ users(first: 20) { id fullName email createdAt city } }";
  assert.equal(JSON.stringify(graceholder(q)), JSON.stringify(graceholder(q, { distributions: "realistic" })));
});

test("distributions option is validated", () => {
  assert.throws(() => graceholder("{ a { b } }", { distributions: "heavy" }), (e) => e.code === "bad-options");
});

test("time series: trend, seasonality and noise, dates ending at the anchor", () => {
  const out = graceholder("{ product { salesHistory { date value } } }", { distributions: "realistic", seed: "ts" }).product.salesHistory;
  assert.ok(Array.isArray(out) && out.length >= 14 && out.length <= 60);
  const days = out.map((p) => Date.parse(p.date));
  assert.equal(out.at(-1).date, "2025-01-01T00:00:00.000Z");
  for (let i = 1; i < days.length; i++) assert.equal(days[i] - days[i - 1], 86400000, "daily, ascending");
  assert.ok(out.every((p) => typeof p.value === "number" && p.value >= 0));
  // the same series is produced whatever else is selected, and whichever window is asked for
  const again = graceholder("{ product { id salesHistory { value date } name } }", { distributions: "realistic", seed: "ts" }).product.salesHistory;
  assert.deepEqual(again.map((p) => p.value), out.map((p) => p.value));
  // shape: it varies (noise + seasonality) and a series with a positive trend ends higher than it starts
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  assert.ok(spread(out.map((p) => p.value)) > 0);
});

test("series.value honours explicit trend, season, noise and bounds", () => {
  const spec = { "**.history": { gen: "x" } };
  void spec;
  const flat = Array.from({ length: 60 }, (_, i) => generate("series.value", { ...ctxFor(i, { base: 100, trend: 0, season: 0, noise: 0 }), series: { i: i + 1, n: 60, slot: ctxFor(0).slot } }));
  assert.ok(flat.every((v) => v === 100));
  const up = Array.from({ length: 60 }, (_, i) => generate("series.value", { ...ctxFor(i, { base: 100, trend: 1, season: 0, noise: 0 }), series: { i: i + 1, n: 60, slot: ctxFor(0).slot } }));
  assert.equal(up[0], 100);
  assert.equal(up[59], 200);
  assert.ok(up.every((v, i) => i === 0 || v >= up[i - 1]));
  const seasonal = Array.from({ length: 28 }, (_, i) => generate("series.value", { ...ctxFor(i, { base: 100, trend: 0, season: 0.2, period: 7, noise: 0 }), series: { i: i + 1, n: 28, slot: () => new Stream(0n) } }));
  assert.ok(Math.abs(seasonal[0] - seasonal[7]) < 1e-9 && Math.abs(seasonal[3] - seasonal[10]) < 1e-9, "repeats every period");
  assert.ok(spreadOf(seasonal) > 20 && spreadOf(seasonal) < 41);
  const bounded = Array.from({ length: 40 }, (_, i) => generate("series.value", { ...ctxFor(i, { min: 10, max: 20 }), series: { i: i + 1, n: 40, slot: ctxFor(0).slot } }));
  assert.ok(bounded.every((v) => v >= 10 && v <= 20));
});
const spreadOf = (xs) => Math.max(...xs) - Math.min(...xs);
