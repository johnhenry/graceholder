import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder, specFromSamples, analyzeSamples, inferSchema } from "../src/index.js";
import { shapePattern } from "../src/learn.js";
import { compileSpec } from "../src/spec.js";

const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const json = JSON.stringify;
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// ---- detection -------------------------------------------------------------------------------

test("numbers: integer and float ranges, with precision", () => {
  const data = { items: [
    { qty: 3, ratio: 0.25, price: 19.99 },
    { qty: 9, ratio: 0.5, price: 5.5 },
    { qty: 4, ratio: 0.125, price: 120 },
  ] };
  const spec = specFromSamples("{ items { qty ratio price } }", data);
  assert.deepEqual(spec["items.qty"].gen, { name: "int", args: { min: 3, max: 9 } });
  assert.deepEqual(spec["items.ratio"].gen, { name: "float", args: { min: 0.125, max: 0.5, decimals: 3 } });
  assert.deepEqual(spec["items.price"].gen, { name: "float", args: { min: 5.5, max: 120, decimals: 2 } });
  assert.deepEqual(spec["items"], { count: 3 });
});

test("booleans: the observed ratio", () => {
  const data = { users: rows(10, (i) => ({ active: i < 3 })) };
  assert.deepEqual(specFromSamples("{ users { active } }", data)["users.active"].gen, { name: "bool", args: { p: 0.3 } });
});

test("null rates, for scalars and objects", () => {
  const data = { users: rows(8, (i) => ({ nick: i % 4 === 0 ? null : "x" + i, boss: i < 2 ? null : { id: i } })) };
  const spec = specFromSamples("{ users { nick boss { id } } }", data);
  assert.equal(spec["users.nick"].nullRate, 0.25);
  assert.equal(spec["users.boss"].nullRate, 0.25);
  assert.equal(specFromSamples("{ users { nick } }", { users: [{ nick: null }, { nick: null }] })["users.nick"].nullRate, 1);
  assert.equal(specFromSamples("{ users { nick } }", { users: [{ nick: "a" }] })["users.nick"]?.nullRate, undefined);
});

test("list sizes: a fixed number, or a range across every parent", () => {
  const data = { orders: [{ lines: [1, 2], notes: [] }, { lines: [1, 2, 3, 4], notes: [] }, { lines: [1], notes: [] }] };
  const spec = specFromSamples("{ orders { lines notes } }", data);
  assert.equal(spec.orders.count, 3);
  assert.deepEqual(spec["orders.lines"].count, [1, 4]);
  assert.equal(spec["orders.notes"].count, 0);
});

test("a list or object whose shape the heuristics get wrong is pinned with list/one", () => {
  const data = { data: { item: [{ n: 1 }, { n: 2 }], users: { n: 3 } } };
  const spec = specFromSamples("{ item { n } users { n } }", data);
  assert.equal(spec.item.list, true);
  assert.equal(spec.item.count, 2);
  assert.equal(spec.users.one, true);
  const out = graceholder("{ item { n } users { n } }", { spec, seed: "q" });
  assert.equal(out.item.length, 2);
  assert.ok(!Array.isArray(out.users));
  assert.equal(specFromSamples("{ users { id } }", { users: [{ id: 1 }, { id: 2 }] }).users.list, undefined, "agreeing with the heuristic needs no entry");
});

test("formats: uuid, email, url, ip, hex, numeric ids", () => {
  const data = { r: rows(6, (i) => ({
    uid: `3f2504e0-4f89-41d3-9a0c-0305e82c33${10 + i}`,
    mail: `person${i}@corp${i}.test`,
    link: `https://example.test/a/${i}`,
    img: `https://cdn.test/${i}.png`,
    addr: `10.0.${i}.7`,
    hash: ["9f86d081", "a3c1e75b", "0b9d44ef", "c7d0a1b2", "5e884898", "ffd0aa11"][i],
    num: String(95 + i * 37),
    code: String(10000 + i),
  })) };
  const spec = specFromSamples("{ r { uid mail link img addr hash num code } }", data);
  assert.equal(spec["r.uid"].gen, "id.uuid");
  assert.equal(spec["r.mail"].gen, "person.email");
  assert.equal(spec["r.link"].gen, "url");
  assert.equal(spec["r.img"].gen, "imageUrl");
  assert.equal(spec["r.addr"].gen, "ip");
  assert.deepEqual(spec["r.hash"].gen, { name: "hex", args: { length: 8 } });
  assert.deepEqual(spec["r.num"].gen, { name: "id.int", args: { min: 95, max: 280, string: true } });
  assert.equal(spec["r.code"].pattern, "#####");
});

test("dates are learned as days before the anchor", () => {
  const data = { events: [{ at: "2024-12-25T10:00:00Z", day: "2024-12-30" }, { at: "2024-06-01T00:00:00.000Z", day: "2024-06-01" }, { at: "2024-12-31T23:00:00+00:00", day: "2024-10-10" }] };
  const spec = specFromSamples("{ events { startsAt day } }".replace("startsAt", "at"), data);
  assert.equal(spec["events.at"].gen.name, "datetime");
  assert.deepEqual(spec["events.at"].gen.args, { minDaysAgo: 0, maxDaysAgo: 214 });
  assert.deepEqual(spec["events.day"].gen.args, { minDaysAgo: 2, maxDaysAgo: 214, format: "date" });
  const out = graceholder("{ events { at day } }", { spec, seed: "d" });
  for (const e of out.events) {
    assert.match(e.day, /^\d{4}-\d{2}-\d{2}$/);
    const t = Date.parse(e.at);
    assert.ok(t > Date.parse("2024-05-31") && t <= Date.parse("2025-01-01"));
  }
  // a different anchor shifts the learned range
  const spec2 = specFromSamples("{ events { at } }", data, { anchorDate: "2025-02-01" });
  assert.deepEqual(spec2["events.at"].gen.args, { minDaysAgo: 31, maxDaysAgo: 245 });
});

test("coherent heuristic dates are kept when they already cover the range; otherwise learned", () => {
  const inside = { u: [{ createdAt: "2023-01-01T00:00:00Z", updatedAt: "2024-06-01T00:00:00Z" }] };
  const { spec, notes } = analyzeSamples("{ u { createdAt updatedAt } }", inside);
  assert.equal(spec["u.createdAt"], undefined); // time.created / time.updated cover these
  assert.equal(spec["u.updatedAt"], undefined);
  assert.ok(notes.some((n) => n.path === "u.createdAt" && n.kind === "kept-heuristic"));
  const outside = { u: [{ createdAt: "2005-01-01T00:00:00Z" }] };
  assert.equal(specFromSamples("{ u { createdAt } }", outside)["u.createdAt"].gen.name, "datetime");
});

test("patterns: shape of codes; an alphabetic prefix is kept only when it is shared and followed by digits or a separator", () => {
  const skus = ["SKU-1042", "SKU-2210", "SKU-3375", "SKU-9001"];
  assert.equal(shapePattern(skus), "SKU-####");
  assert.equal(shapePattern(["usr_a1b2", "usr_9fz0", "usr_k3m4"]), "usr_**?#");
  assert.equal(shapePattern(["AB12", "CD34", "EF56"]), "AA##");
  assert.equal(shapePattern(["555-0100", "555-0199", "555-0142"]), "###-####");
  assert.equal(shapePattern(["x-1", "y-2"]), "?-#");
  assert.equal(shapePattern(["ORD-0001"]), "AAA-####", "one distinct value: the format only, no letters copied");
  assert.equal(shapePattern(["Alice", "Bobby", "Carol"]), null, "letters only: not a format");
  assert.equal(shapePattern(["a b1", "c d2"]), null, "no spaces");
  assert.equal(shapePattern(["A-1", "A_1"]), null, "different punctuation");
  assert.equal(shapePattern(["AB", "CD"]), "AA", "all-uppercase codes");
  assert.equal(shapePattern(["a#1", "b#2"]), "?\\##");
  assert.equal(shapePattern(["ABCDEFG-1", "ABCDEFG-2"]), "AAAAAAA-#", "a prefix longer than 5 is not copied");
  const spec = specFromSamples("{ p { sku } }", { p: skus.map((sku) => ({ sku })) });
  assert.equal(spec["p.sku"].pattern, "SKU-####");
  for (const p of graceholder("{ p { sku } }", { spec, seed: "x" }).p) assert.match(p.sku, /^SKU-\d{4}$/);
});

test("enum-like sets are withheld by default and copied with allowValues", () => {
  const statuses = rows(12, (i) => ({ status: ["open", "open", "open", "closed", "pending", "closed"][i % 6] }));
  const q = "{ tickets { status } }";
  const data = { tickets: statuses };
  const plain = analyzeSamples(q, data);
  assert.equal(plain.spec["tickets.status"], undefined);
  assert.ok(plain.notes.some((n) => n.path === "tickets.status" && n.kind === "withheld" && /allowValues/.test(n.message)));
  const all = specFromSamples(q, data, { allowValues: true });
  assert.deepEqual(all["tickets.status"].pick, [{ value: "open", weight: 6 }, { value: "closed", weight: 4 }, { value: "pending", weight: 2 }]);
  assert.deepEqual(specFromSamples(q, data, { allowValues: ["tickets.status"] })["tickets.status"], all["tickets.status"]);
  assert.equal(specFromSamples(q, data, { allowValues: ["tickets.other"] })["tickets.status"], undefined);
  const even = specFromSamples(q, { tickets: [{ status: "b" }, { status: "a" }, { status: "a" }, { status: "b" }] }, { allowValues: true });
  assert.deepEqual(even["tickets.status"].pick, ["a", "b"], "equal counts: a plain, sorted list");
  assert.deepEqual(specFromSamples(q, { tickets: [{ status: "OPEN" }, { status: "DONE" }] }, { allowValues: true })["tickets.status"].pick, ["DONE", "OPEN"]);
});

test("free text: lengths only, and the heuristic generator is kept for names", () => {
  const people = ["Alice Johnson", "Bob", "Carol Anne Whitfield-Smythe", "Daniel Okafor"];
  const notes = ["The quick brown fox jumps over the lazy dog.", "Short note.", "Another, rather longer, free-text remark about nothing."];
  const data = { users: people.map((name, i) => ({ name, note: notes[i % 3], title: `Report ${i}` })) };
  const { spec, notes: n } = analyzeSamples("{ users { name note title } }", data);
  assert.equal(spec["users.name"], undefined, "a name keeps the person generator");
  assert.ok(n.some((x) => x.path === "users.name" && x.kind === "kept-heuristic"));
  assert.deepEqual(spec["users.note"].gen, { name: "text", args: { min: 11, max: 55 } }, "`note` is an unknown name (T13), so its length range is learned");
  assert.equal(spec["users.title"], undefined, "a job title keeps its heuristic");
  assert.ok(!json(spec).includes("fox") && !json(spec).includes("Alice"));
});

test("free text of a text-like field gets a length range from the text generator", () => {
  const data = { posts: ["A short body.", "A somewhat longer body of text, with commas.", "Tiny"].map((body) => ({ body })) };
  const spec = specFromSamples("{ posts { body } }", data);
  assert.deepEqual(spec["posts.body"].gen, { name: "text", args: { min: 4, max: 44 } });
  const out = graceholder("{ posts { body } }", { spec, seed: "t" });
  assert.ok(out.posts.length >= 3);
  for (const p of out.posts) assert.ok(p.body.length >= 4 && p.body.length <= 44, p.body);
});

test("identifiers and aggregates are never learned", () => {
  const data = { users: [{ id: "u-1", orderCount: 5, posts: [1, 2] }, { id: "u-2", orderCount: 7, posts: [1] }] };
  const { spec, notes } = analyzeSamples("{ users { id orderCount } }", data);
  assert.equal(spec["users.id"], undefined);
  assert.ok(notes.some((n) => n.path === "users.id" && n.kind === "kept-heuristic"));
});

test("fields set by a directive in the query are left alone", () => {
  const q = '{ users @count(n: 2) { age @gen(name: "int", min: 1, max: 2) nick @nullRate(p: 0.5) } }';
  const data = { users: rows(5, (i) => ({ age: 40 + i, nick: i === 0 ? null : "n" })) };
  const spec = specFromSamples(q, data);
  assert.equal(spec["users"], undefined);
  assert.equal(spec["users.age"], undefined);
  assert.equal(spec["users.nick"]?.nullRate, undefined);
});

test("paged lists keep the page size out of the spec", () => {
  const { spec, notes } = analyzeSamples("{ users(first: 2) { age } }", { users: [{ age: 30 }, { age: 31 }] });
  assert.equal(spec.users, undefined);
  assert.ok(notes.some((n) => n.path === "users" && /paged/.test(n.message)));
});

test("connections: totalCount becomes the declared size", () => {
  const q = "{ posts(first: 2) { totalCount edges { node { views } } } }";
  const data = { posts: { totalCount: 57, edges: [{ node: { views: 10 } }, { node: { views: 400 } }] } };
  const spec = specFromSamples(q, data);
  assert.equal(spec.posts.count, 57);
  assert.deepEqual(spec["posts.edges.node.views"].gen, { name: "int", args: { min: 10, max: 400 } });
  const out = graceholder(q, { spec, seed: "c" });
  assert.equal(out.posts.totalCount, 57);
  assert.ok(out.posts.edges.every((e) => e.node.views >= 10 && e.node.views <= 400));
});

test("aliases, fragments and several samples", () => {
  const q = "query Q { people: users { ...U } } fragment U on User { years: age ... on User { ok: active } }";
  const a = { data: { people: [{ years: 30, ok: true }, { years: 41, ok: false }] } };
  const b = { people: [{ years: 25, ok: true }] };
  const spec = specFromSamples(q, [a, b]);
  assert.deepEqual(spec["users.age"].gen, { name: "int", args: { min: 25, max: 41 } });
  assert.deepEqual(spec["users.active"].gen.args, { p: 0.667 });
  assert.deepEqual(spec.users, { count: [1, 2] });
  // the spec is keyed by field names, so it drives the same query
  const out = graceholder(q, { spec, seed: "z" });
  assert.ok(out.people.every((p) => p.years >= 25 && p.years <= 41));
});

test("the result is a valid spec, deterministic, and independent of sample order", () => {
  const q = "{ users { id age active tags { n } } }";
  const samples = rows(6, (i) => ({ users: rows(2 + (i % 3), (j) => ({ id: String(j), age: 20 + i * 3 + j, active: (i + j) % 2 === 0, tags: rows(i % 2, (k) => ({ n: k })) })) }));
  const spec = specFromSamples(q, samples);
  assert.doesNotThrow(() => compileSpec(spec));
  assert.equal(json(spec), json(specFromSamples(q, samples)));
  assert.equal(json(spec), json(specFromSamples(q, [...samples].reverse())));
  assert.doesNotThrow(() => graceholder(q, { spec }));
  assert.equal(json(JSON.parse(json(spec))), json(spec), "plain JSON");
});

test("bad samples are reported with bad-samples", () => {
  const q = "{ users { age name } }";
  assert.equal(err(() => specFromSamples(q, []))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples(q, "nope"))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples(q, [null]))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples(q, { data: null, errors: [] }))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples(q, { users: [{ age: 1, name: { first: "x" } }] }))?.code, undefined, "an object in a scalar position is an opaque value");
  assert.equal(err(() => specFromSamples("{ users { age } }", { users: [5] }))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples("{ user { age } }", [{ user: { age: 1 } }, { user: [{ age: 1 }] }]))?.code, "bad-samples");
  assert.equal(err(() => specFromSamples(q, { users: [] }, { allowValues: "yes" }))?.code, "bad-options");
  assert.equal(err(() => specFromSamples(q, { users: [] }, { maxEnum: 0 }))?.code, "bad-options");
  assert.equal(err(() => specFromSamples("{ a", { a: 1 }))?.code, "graphql");
  assert.deepEqual(specFromSamples(q, { users: [] }), { users: { count: 0 } });
});

// ---- privacy ---------------------------------------------------------------------------------

test("privacy: no sample string ends up in the spec unless allowValues says so", () => {
  const secret = ["Harriet Quimby", "harriet@secret-corp.example", "Quarterly review of Project Nightingale", "Ward 7B", "violet", "ACME", "hq-7731-nightingale", "4 Elm Street"];
  const data = { staff: rows(10, (i) => ({
    fullName: secret[0], mail: `${i}${secret[1]}`, note: secret[2] + " " + i, room: secret[3] + i, color: secret[4],
    org: secret[5], code: secret[6] + i, addr: secret[7] + " " + i, stage: ["alpha", "beta", "gamma"][i % 3],
  })) };
  const q = "{ staff { fullName mail note room color org code addr stage } }";
  const parts = secret.flatMap((s) => s.split(/[\s@.-]+/)).filter((p) => p.length >= 4 && !/^[0-9]+$/.test(p));
  const text = json(specFromSamples(q, data));
  for (const part of parts) assert.ok(!text.toLowerCase().includes(part.toLowerCase()), `${part} leaked into ${text}`);
  assert.ok(!/alpha|beta|gamma/.test(text), text);
  // with allowValues the enum-like sets are copied (a constant is a set of one); free text and personal names are not
  const allowed = specFromSamples(q, data, { allowValues: true });
  const copied = json(allowed);
  assert.deepEqual(allowed["staff.stage"].pick.map((p) => p.value).sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual(allowed["staff.color"].pick, ["violet"]);
  for (const part of ["Harriet", "Quimby", "Nightingale", "Quarterly", "Elm", "secret"]) assert.ok(!copied.includes(part), `${part} leaked into ${copied}`);
});

test("privacy: personal-name generators never get copied values, even with allowValues", () => {
  const data = { staff: rows(6, (i) => ({ fullName: ["Ada Lovelace", "Alan Turing"][i % 2], username: ["ada", "alan"][i % 2] })) };
  const { spec, notes } = analyzeSamples("{ staff { fullName username } }", data, { allowValues: true });
  assert.equal(spec["staff.fullName"], undefined);
  assert.equal(spec["staff.username"], undefined);
  assert.ok(notes.some((n) => n.path === "staff.fullName" && n.kind === "withheld"));
});

test("privacy: a single sample never reveals letters", () => {
  const spec = specFromSamples("{ p { ref } }", { p: [{ ref: "BRAVO-7731" }] });
  assert.equal(spec["p.ref"].pattern, "AAAAA-####");
});

// ---- round trip ------------------------------------------------------------------------------

test("round trip: generate, learn, generate again gives compatible output", () => {
  const query = "{ users { id name active nickname age score sku status tags seenAt orders { code total } } }";
  const original = {
    users: { count: 240 },
    "users.active": { gen: { name: "bool", args: { p: 0.3 } } },
    "users.nickname": { nullRate: 0.25 },
    "users.age": { gen: { name: "int", args: { min: 21, max: 64 } } },
    "users.score": { gen: { name: "float", args: { min: 0, max: 4.5, decimals: 1 } } },
    "users.sku": { pattern: "SKU-####" },
    "users.status": { pick: [{ value: "active", weight: 6 }, { value: "paused", weight: 3 }, { value: "closed", weight: 1 }] },
    "users.tags": { count: [0, 3] },
    "users.seenAt": { gen: { name: "datetime", args: { minDaysAgo: 100, maxDaysAgo: 400 } } },
    "users.orders": { count: [1, 4] },
    "users.orders.code": { pattern: "ORD-A###" },
  };
  const real = graceholder(query, { spec: original, seed: "production" });
  const learned = specFromSamples(query, real, { allowValues: true });

  assert.equal(learned.users.count, 240);
  assert.deepEqual(learned["users.orders"].count, [1, 4]);
  assert.deepEqual(learned["users.tags"].count, [0, 3]);
  assert.ok(Math.abs(learned["users.active"].gen.args.p - 0.3) < 0.1);
  assert.ok(Math.abs(learned["users.nickname"].nullRate - 0.25) < 0.1);
  assert.deepEqual(learned["users.age"].gen.args, { min: 21, max: 64 });
  assert.ok(learned["users.score"].gen.args.max <= 4.5 && learned["users.score"].gen.args.max > 4);
  assert.equal(learned["users.score"].gen.args.decimals, 1);
  assert.equal(learned["users.sku"].pattern, "SKU-####");
  assert.equal(learned["users.orders.code"].pattern, "ORD-A###");
  assert.deepEqual(learned["users.status"].pick.map((p) => p.value), ["active", "paused", "closed"]);
  const created = learned["users.seenAt"].gen.args;
  assert.ok(created.minDaysAgo >= 100 && created.minDaysAgo < 110 && created.maxDaysAgo <= 400 && created.maxDaysAgo > 390, json(created));

  // generate again from the learned spec with another seed and compare the statistics
  const again = graceholder(query, { spec: learned, seed: "staging" });
  assert.equal(again.users.length, 240);
  const rate = (rows, f) => rows.filter(f).length / rows.length;
  const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  near(rate(again.users, (u) => u.active), rate(real.users, (u) => u.active), 0.12);
  near(rate(again.users, (u) => u.nickname === null), rate(real.users, (u) => u.nickname === null), 0.12);
  near(rate(again.users, (u) => u.status === "active"), rate(real.users, (u) => u.status === "active"), 0.12);
  for (const u of again.users) {
    assert.ok(u.age >= 21 && u.age <= 64);
    assert.match(u.sku, /^SKU-\d{4}$/);
    assert.ok(["active", "paused", "closed"].includes(u.status));
    assert.ok(u.tags.length <= 3);
    assert.ok(u.orders.length >= 1 && u.orders.length <= 4);
    for (const o of u.orders) assert.match(o.code, /^ORD-[A-Z]\d{3}$/);
  }
  const mean = (rows, f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  near(mean(again.users, (u) => u.age), mean(real.users, (u) => u.age), 3);
  // learning from the regenerated data again is a fixed point of the structure
  const relearned = specFromSamples(query, again, { allowValues: true });
  assert.equal(relearned["users.sku"].pattern, learned["users.sku"].pattern);
  assert.deepEqual(relearned["users.orders"].count, learned["users.orders"].count);
  assert.deepEqual(relearned["users.age"].gen.args, learned["users.age"].gen.args);
});

// ---- schema mode -----------------------------------------------------------------------------

const SDL = `
enum Status { OPEN CLOSED PENDING }
type Query { tickets: [Ticket!]! }
type Ticket { id: ID! status: Status! priority: Status owner: String! score: Float! count: Int! labels: [String!]! }
`;

test("schema mode: enum frequencies come without allowValues; scalar types decide int vs float", () => {
  const q = "{ tickets { status priority score count labels } }";
  const data = { tickets: [
    { status: "OPEN", priority: null, score: 2, count: 1, labels: ["x"] },
    { status: "OPEN", priority: "OPEN", score: 4, count: 7, labels: [] },
    { status: "CLOSED", priority: "PENDING", score: 3, count: 4, labels: ["y", "z"] },
  ] };
  const spec = specFromSamples(q, data, { schema: SDL });
  assert.deepEqual(spec["tickets.status"].pick, [{ value: "OPEN", weight: 2 }, { value: "CLOSED", weight: 1 }]);
  assert.equal(spec["tickets.priority"].nullRate, 0.333);
  assert.deepEqual(spec["tickets.score"].gen, { name: "float", args: { min: 2, max: 4, decimals: 0 } }, "a Float stays a float even when the samples look integral");
  assert.deepEqual(spec["tickets.count"].gen, { name: "int", args: { min: 1, max: 7 } });
  assert.equal(spec["tickets.list"], undefined);
  assert.equal(spec.tickets.list, undefined, "list-ness is the schema's");
  assert.deepEqual(spec["tickets.labels"], { count: [0, 2], gen: { name: "text", args: { min: 1, max: 1 } } });
  // the learned spec works with the schema, including the enum picks
  const out = graceholder(q, { spec, schema: SDL, seed: "k" });
  assert.ok(out.tickets.every((t) => ["OPEN", "CLOSED"].includes(t.status)));
  assert.equal(inferSchema(q, spec, { schema: SDL }).decisions.filter((d) => d.kind === "unused").length, 0);
});

test("schema mode: samples that contradict the schema are bad-samples", () => {
  const q = "{ tickets { status owner labels } }";
  const base = { status: "OPEN", owner: "a", labels: [] };
  const code = (row) => err(() => specFromSamples(q, { tickets: [row] }, { schema: SDL }))?.code;
  assert.equal(code(base), undefined);
  assert.equal(code({ ...base, status: "WEIRD" }), "bad-samples");
  assert.equal(code({ ...base, owner: null }), "bad-samples");
  assert.equal(code({ ...base, labels: "x" }), "bad-samples");
  assert.equal(err(() => specFromSamples("{ tickets { nope } }", { tickets: [] }, { schema: SDL }))?.code, "graphql");
});
