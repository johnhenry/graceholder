import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";
import { asciiFold } from "../src/generators.js";
import { keyString } from "../src/key.js";

const ANCHOR = "2025-01-01T00:00:00.000Z";
const run = (q, o) => graceholder(q, { seed: "p", ...o });
const json = (v) => JSON.stringify(v);
const USERS = "{ users(first: 1000) { id firstName lastName fullName name username email phone city state country zip } }";

test("persona slot keys are scope p, one key per slot", () => {
  assert.equal(
    keyString({ seed: "s", scope: "p", typeName: "User", entityKey: "42", fieldName: "first" }),
    "gh1\x1fs\x1fp\x1fUser\x1f42\x1ffirst",
  );
});

test("asciiFold: accents, case and punctuation", () => {
  assert.equal(asciiFold("José"), "jose");
  assert.equal(asciiFold("Zoë"), "zoe");
  assert.equal(asciiFold("Müller"), "muller");
  assert.equal(asciiFold("Çelik"), "celik");
  assert.equal(asciiFold("O'Brien-Smith"), "obriensmith");
  assert.equal(asciiFold("Ø"), "o");
});

test("persona coherence over 1000 entities: names, username, email", () => {
  const { users } = run(USERS);
  assert.equal(users.length, 1000);
  let accents = 0;
  for (const u of users) {
    assert.equal(u.fullName, `${u.firstName} ${u.lastName}`);
    assert.equal(u.name, u.fullName);
    const f = asciiFold(u.firstName);
    const l = asciiFold(u.lastName);
    const [local, domain] = u.email.split("@");
    assert.match(domain, /^[a-z.]+\.(com|org|net)$/);
    assert.ok(local.includes(f) && local.includes(l), `${u.email} vs ${u.fullName}`);
    assert.match(u.email, /^[a-z0-9.@]+$/); // ASCII only
    assert.ok(u.username.includes(f) || u.username.includes(f[0] + l) || u.username.includes(l), `${u.username} vs ${u.fullName}`);
    assert.match(u.username, /^[a-z0-9.]+$/);
    if (/[^\x00-\x7f]/.test(u.fullName)) accents++;
  }
  assert.ok(accents > 0, "the vocabulary should exercise ASCII folding");
  // location fields are one coherent row
  const rows = new Set(users.map((u) => `${u.city}|${u.state}|${u.country}`));
  assert.ok(rows.size <= 24);
  for (const u of users) {
    if (u.country === "Canada") assert.match(u.zip, /^[A-Z]\d[A-Z] \d[A-Z]\d$/);
    else assert.match(u.zip, /^\d{5}$/);
  }
});

test("the same persona gives the same values everywhere", () => {
  const out = run("{ me: user(id: 7) { fullName email username } users(ids: [7]) { fullName email username } posts { author { ... on User { id fullName email } } } }");
  assert.equal(json(out.me), json(out.users[0]));
  const q = run("{ a: user(id: 7) { email } b: user(id: 7) { email firstName } }");
  assert.equal(q.a.email, q.b.email);
  assert.ok(asciiFold(q.b.email).includes(asciiFold(q.b.firstName)));
});

test("persona slot isolation: selecting more fields never changes the others", () => {
  const base = run("{ users { id fullName email } }").users;
  const more = run("{ users { bio phone jobTitle: title id city fullName createdAt age email avatarUrl } }").users;
  assert.equal(json(base), json(more.map(({ id, fullName, email }) => ({ id, fullName, email }))));
  // and vice versa: a persona field does not depend on the sibling that sits beside it
  const alone = run("{ users { phone } }").users;
  assert.equal(json(alone), json(more.map(({ phone }) => ({ phone }))));
});

test("different entities have different personas", () => {
  const { users } = run("{ users(first: 50) { fullName } }");
  assert.ok(new Set(users.map((u) => u.fullName)).size > 25);
});

test("scalar lists of persona values vary per element", () => {
  const { users } = run("{ users { emails } }");
  for (const u of users) assert.ok(new Set(u.emails).size > 1 || u.emails.length === 1);
});

// ---- dates ----------------------------------------------------------------------

const DATES = "{ users(first: 1000) { createdAt updatedAt publishedAt deletedAt birthday age } }";

test("createdAt <= updatedAt <= anchorDate over 1000 entities", () => {
  const anchor = Date.parse(ANCHOR);
  for (const u of run(DATES).users) {
    const c = Date.parse(u.createdAt);
    const up = Date.parse(u.updatedAt);
    const pub = Date.parse(u.publishedAt);
    assert.ok(c <= up && up <= anchor, `${u.createdAt} ${u.updatedAt}`);
    assert.ok(c <= pub && pub <= anchor, `${u.createdAt} ${u.publishedAt}`);
    assert.ok(anchor - c >= 30 * 86400000 && anchor - c <= 1500 * 86400000);
    assert.equal(u.deletedAt, null);
  }
});

test("birthday is consistent with age", () => {
  const anchor = Date.parse(ANCHOR);
  for (const u of run(DATES).users) {
    assert.ok(u.age >= 18 && u.age <= 90);
    const years = Math.floor((anchor - Date.parse(u.birthday)) / (365.25 * 86400000));
    assert.equal(years, u.age);
  }
});

test("changing anchorDate shifts dates and leaves everything else alone", () => {
  const q = "{ users(first: 50) { id fullName email age createdAt updatedAt publishedAt birthday deletedAt startDate } }";
  const a = run(q).users;
  const shift = 400 * 86400000;
  const b = run(q, { anchorDate: new Date(Date.parse(ANCHOR) + shift) }).users;
  for (let i = 0; i < a.length; i++) {
    for (const k of Object.keys(a[i])) {
      if (["createdAt", "updatedAt", "publishedAt", "birthday", "startDate"].includes(k)) {
        assert.equal(Date.parse(b[i][k]) - Date.parse(a[i][k]), shift, k);
      } else {
        assert.equal(b[i][k], a[i][k], k);
      }
    }
  }
});

test("deletedAt is nullable in the inferred schema", async () => {
  const { inferSchema } = await import("../src/index.js");
  assert.match(inferSchema("{ users { deletedAt } }").sdl, /deletedAt: DateTime\n/);
});

// ---- totals and counts ------------------------------------------------------------

const cents = (x) => Math.round(x * 100);

test("total = subtotal + tax; subtotal = sum of items, independent of the window", () => {
  const full = run("{ orders { id subtotal tax total items { price quantity } } }").orders;
  for (const o of full) {
    const sum = o.items.reduce((s, i) => s + cents(i.price) * i.quantity, 0);
    assert.equal(cents(o.subtotal), sum);
    assert.equal(cents(o.total), cents(o.subtotal) + cents(o.tax));
    assert.ok(o.tax >= 0);
  }
  const windowed = run("{ orders { id subtotal tax total items(first: 1) { price quantity } } }").orders;
  assert.deepEqual(windowed.map((o) => [o.subtotal, o.tax, o.total]), full.map((o) => [o.subtotal, o.tax, o.total]));
  // totals do not need items to be selected
  const bare = run("{ orders { id subtotal total } }").orders;
  assert.deepEqual(bare.map((o) => [o.subtotal, o.total]), full.map((o) => [o.subtotal, o.total]));
  // and total alone still equals subtotal + tax
  const alone = run("{ orders { total } }").orders;
  assert.deepEqual(alone.map((o) => o.total), full.map((o) => o.total));
});

test("prices are cents-based with two decimals", () => {
  const { products } = run("{ products(first: 200) { price } }");
  const endings = new Set();
  for (const p of products) {
    assert.equal(cents(p.price) / 100, p.price);
    endings.add(Math.round(p.price * 100) % 100);
  }
  assert.ok(endings.has(99) && endings.has(0) && endings.has(49));
});

test("xCount equals the list total", () => {
  const out = run("{ posts { commentCount comments { id } tagCount tags totalShares shares { id } } }").posts;
  for (const p of out) {
    assert.equal(p.commentCount, p.comments.length);
    assert.equal(p.tagCount, p.tags.length);
    assert.equal(p.totalShares, p.shares.length);
  }
  // the count is the same when the list is not selected
  const lone = run("{ posts { commentCount } }").posts;
  assert.deepEqual(lone.map((p) => p.commentCount), out.map((p) => p.commentCount));
  const plural = run("{ posts { categoryCount categories { id } } }").posts;
  for (const p of plural) assert.equal(p.categoryCount, p.categories.length);
});

test("locale: only en, unknown throws", () => {
  assert.equal(json(run(USERS, { locale: "en" })), json(run(USERS)));
  assert.throws(() => run(USERS, { locale: "fr" }), (e) => e.code === "unknown-locale");
});

test("clock and randomness cannot leak in (system clock faked)", () => {
  const RealDate = globalThis.Date;
  const before = json(run(`${DATES}`));
  try {
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [42])); }
      static now() { return 42; }
    };
    assert.equal(json(run(DATES)), before);
  } finally {
    globalThis.Date = RealDate;
  }
});
