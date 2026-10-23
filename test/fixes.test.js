import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";
import { windowOf } from "../src/execute.js";
import { encodeCursor } from "../src/cursor.js";

const run = (q, o) => graceholder(q, { seed: "demo", ...o });
const ids = (l) => l.map((x) => x.id);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const U = (args) => `{ users(${args}) { id name } }`;
const all = run(U("first: 40")).users;

test("first + offset: the size comes from first", () => {
  assert.deepEqual(ids(run(U("first: 2, offset: 4")).users), ["5", "6"]);
  assert.deepEqual(ids(run(U("first: 2, skip: 4")).users), ["5", "6"]);
  assert.deepEqual(ids(run(U("limit: 2, offset: 4")).users), ["5", "6"]);
  assert.deepEqual(ids(run(U("take: 3, skip: 1")).users), ["2", "3", "4"]);
  assert.deepEqual(ids(run(U("take: 3, offset: 1")).users), ["2", "3", "4"]);
  assert.equal(run(U("offset: 4")).users[0].id, "5"); // no size: the collection count
  assert.deepEqual(ids(run(U("first: 0, offset: 4")).users), []);
});

test("every combination of paging arguments is either correct or rejected", () => {
  const sizes = { first: 3, limit: 3, take: 3, pageSize: 3, perPage: 3 };
  const names = ["first", "last", "after", "before", "offset", "skip", "limit", "take", "page", "pageSize", "perPage"];
  const value = { after: 2, before: 9, offset: 4, skip: 4, page: 2, last: 3, ...sizes };
  const ok = [];
  for (let mask = 1; mask < 1 << names.length; mask++) {
    const picked = names.filter((_, i) => mask & (1 << i));
    const args = Object.fromEntries(picked.map((n) => [n, n === "after" || n === "before" ? encodeCursor(value[n]) : value[n]]));
    let w, err;
    try { w = windowOf(args, 5, { connection: false }); } catch (e) { err = e; }
    const has = (n) => picked.includes(n);
    const sizeArgs = picked.filter((n) => n in sizes);
    const offsets = picked.filter((n) => n === "offset" || n === "skip");
    const relay = picked.filter((n) => ["last", "after", "before"].includes(n));
    const pageStyle = has("page") || has("pageSize") || has("perPage");
    const legal =
      sizeArgs.length <= 1 && offsets.length <= 1 &&
      (pageStyle ? has("page") && sizeArgs.every((n) => n === "pageSize" || n === "perPage") && !offsets.length && !relay.length :
       offsets.length ? !relay.length && sizeArgs.every((n) => n !== "pageSize" && n !== "perPage") :
       has("last") ? !has("first") && !sizeArgs.length :
       sizeArgs.every((n) => n === "first") || (!has("after") && !has("before")));
    if (!legal) { assert.equal(err?.code, "bad-arguments", picked.join("+")); continue; }
    assert.ok(w, `${picked.join("+")} should be legal: ${err?.message}`);
    ok.push(picked.join("+"));
    // the size, when one is given, is the window size (except where the window is clipped at `before`)
    if (sizeArgs.length && !has("before") && !has("last")) assert.equal(w.count, 3, picked.join("+"));
    if (has("offset") || has("skip")) assert.equal(w.start, 5, picked.join("+"));
    if (has("page")) assert.equal(w.start, (sizeArgs.length ? 3 : 5) + 1, picked.join("+")); // page 2
  }
  assert.ok(ok.length > 20);
});

test("the documented combinations match the plain windows", () => {
  const slice = (a, b) => ids(all.slice(a, b));
  const at = (n) => encodeCursor(n);
  assert.deepEqual(ids(run(U("first: 3, after: \"" + at(2) + "\"")).users), slice(2, 5));
  assert.deepEqual(ids(run(U("last: 3, before: \"" + at(8) + "\"")).users), slice(4, 7));
  assert.deepEqual(ids(run(U("page: 3, pageSize: 4")).users), slice(8, 12));
  assert.deepEqual(ids(run(U("first: 5, before: \"" + at(4) + "\"")).users), slice(0, 3));
  assert.deepEqual(ids(run(U("limit: 3")).users), slice(0, 3));
});

test("conflicting sizes and mixed styles are bad-arguments", () => {
  for (const args of ["first: 2, limit: 3", "first: 2, take: 3", "limit: 2, take: 3", "pageSize: 2, perPage: 3, page: 1", "offset: 1, skip: 2", "first: 2, last: 2", "page: 1, offset: 2", "page: 1, first: 2", "first: 2, pageSize: 2", "offset: 1, after: \"" + encodeCursor(1) + "\"", "pageSize: 3"]) {
    assert.equal(code(() => run(U(args))), "bad-arguments", args);
  }
});

test("connections follow the same rules", () => {
  const c = run("{ users(first: 2, offset: 4) { edges { node { id } } } }").users;
  assert.deepEqual(c.edges.map((e) => e.node.id), ["5", "6"]);
});

// ---- aggregates use latent values -----------------------------------------------------

const cents = (x) => Math.round(x * 100);

test("subtotal = sum(price * quantity) with a latent quantity, whatever is selected", () => {
  const withQty = run("{ orders(first: 6) { subtotal tax total items { price quantity } } }").orders;
  for (const o of withQty) {
    assert.equal(cents(o.subtotal), o.items.reduce((s, i) => s + cents(i.price) * i.quantity, 0));
    assert.equal(cents(o.total), cents(o.subtotal) + cents(o.tax));
  }
  // the reported case: with only `price` selected the quantity is simply hidden
  const only = run("{ orders(first: 6) { subtotal tax total items { price } } }").orders;
  assert.deepEqual(only.map((o) => [o.subtotal, o.tax, o.total]), withQty.map((o) => [o.subtotal, o.tax, o.total]));
  assert.deepEqual(only.map((o) => o.items.map((i) => i.price)), withQty.map((o) => o.items.map((i) => i.price)));
});

test("quantity and qty are the same latent value and selecting either changes nothing else", () => {
  const variants = [
    "items { price }",
    "items { price quantity }",
    "items { quantity price }",
    "items { price qty }",
    "items { name qty price description }",
    "items(first: 1) { price }",
    "",
  ];
  const results = variants.map((v) => run(`{ orders(first: 4) { subtotal tax total ${v} } }`).orders);
  for (const r of results) assert.deepEqual(r.map((o) => [o.subtotal, o.tax, o.total]), results[0].map((o) => [o.subtotal, o.tax, o.total]));
  const q = run("{ orders(first: 4) { items { quantity } } }").orders;
  const qty = run("{ orders(first: 4) { items { qty } } }").orders;
  assert.deepEqual(q.map((o) => o.items.map((i) => i.quantity)), qty.map((o) => o.items.map((i) => i.qty)));
  const p = (r) => r.map((o) => o.items?.map((i) => i.price));
  assert.deepEqual(p(results[0]), p(results[1]));
  assert.deepEqual(p(results[1]), p(results[3]));
});

// deterministic subsets
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);

test("property: adding or removing fields never changes an aggregate", () => {
  const rnd = lcg(7);
  const orderExtra = ["id", "code", "status", "createdAt", "updatedAt", "customer { name email }", "notes { id }", "comments { id }"];
  const itemsForms = [null, "items { price }", "items { price quantity }", "items { name }", "items { qty price }"];
  const aggregates = ["subtotal", "tax", "total", "itemCount", "commentCount"];
  const keep = (o) => ({ subtotal: o.subtotal, tax: o.tax, total: o.total, itemCount: o.itemCount, commentCount: o.commentCount });
  const base = run("{ orders(first: 5) { subtotal tax total itemCount commentCount } }").orders.map(keep);
  const prices = run("{ orders(first: 5) { items { price } } }").orders.map((o) => o.items.map((i) => i.price));
  for (let trial = 0; trial < 60; trial++) {
    const extra = orderExtra.filter(() => rnd() < 0.4);
    const items = itemsForms[Math.floor(rnd() * itemsForms.length)];
    if (items) extra.push(items);
    // a random subset of the aggregates is always selected, in random order
    const wanted = aggregates.filter(() => rnd() < 0.6);
    const sel = [...new Set([...(wanted.length ? wanted : ["subtotal"]), ...extra])].sort(() => rnd() - 0.5);
    const out = run(`{ orders(first: 5) { ${sel.join(" ")} } }`).orders;
    for (const name of aggregates) if (sel.includes(name)) assert.deepEqual(out.map((o) => o[name]), base.map((o) => o[name]), `${name} in ${sel.join(" ")}`);
    if (items?.includes("price")) assert.deepEqual(out.map((o) => o.items.map((i) => i.price)), prices);
  }
});

test("property: xCount and totalX are the sibling list's total whatever else is selected", () => {
  const rnd = lcg(11);
  const base = run("{ posts { commentCount totalShares tagCount } }").posts;
  const extras = ["id", "title", "body", "comments { id }", "comments(first: 1) { id text }", "shares { id }", "tags", "author { ... on User { name } }", "createdAt"];
  for (let trial = 0; trial < 60; trial++) {
    const picked = extras.filter(() => rnd() < 0.4);
    const sel = ["commentCount", "totalShares", "tagCount", ...picked.filter((x) => !(x.startsWith("comments(") && picked.includes("comments { id }")))].sort(() => rnd() - 0.5);
    const out = run(`{ posts { ${sel.join(" ")} } }`).posts;
    assert.deepEqual(out.map((p) => [p.commentCount, p.totalShares, p.tagCount]), base.map((p) => [p.commentCount, p.totalShares, p.tagCount]), sel.join(" "));
    for (const p of out) {
      if (p.comments && !sel.some((x) => x.startsWith("comments("))) assert.equal(p.comments.length, p.commentCount);
      if (p.shares) assert.equal(p.shares.length, p.totalShares);
      if (p.tags) assert.equal(p.tags.length, p.tagCount);
    }
  }
});

test("windowing the items does not change the aggregates", () => {
  const full = run("{ orders(first: 4) { subtotal tax total items { price } } }").orders;
  const win = run("{ orders(first: 4) { subtotal tax total items(first: 1) { price } } }").orders;
  assert.deepEqual(win.map((o) => [o.subtotal, o.tax, o.total]), full.map((o) => [o.subtotal, o.tax, o.total]));
  for (const o of full) assert.ok(o.items.length >= 3 && o.items.length <= 10);
});

test("xCount and totalX equal the length of the unwindowed list, and the total of a windowed one", () => {
  const out = run("{ posts { commentCount comments { id } totalShares shares { id } tagCount tags } }").posts;
  for (const p of out) {
    assert.equal(p.commentCount, p.comments.length);
    assert.equal(p.totalShares, p.shares.length);
    assert.equal(p.tagCount, p.tags.length);
  }
  const win = run("{ posts { commentCount comments(first: 1) { id } } }").posts;
  assert.deepEqual(win.map((p) => p.commentCount), out.map((p) => p.commentCount));
  const declared = run("{ posts { commentCount comments @count(n: 2) { id } } }").posts;
  for (const p of declared) assert.equal(p.commentCount, 2);
});
