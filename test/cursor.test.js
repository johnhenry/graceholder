import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "../src/cursor.js";
import { entityKeyFromArgs, canonicalJson, argsKeyOf } from "../src/args.js";

test("cursors: base64url('gc1:' + i), unpadded, round trip", () => {
  assert.equal(encodeCursor(2), "Z2MxOjI"); // the worked example in the design
  for (const i of [0, 1, 2, 9, 10, 99, 1000, 123456789]) assert.equal(decodeCursor(encodeCursor(i)), i);
  assert.match(encodeCursor(123456789), /^[A-Za-z0-9_-]+$/);
});

test("cursors: undecodable input is a bad-cursor error", () => {
  for (const bad of ["", "nope", "Z2MyOjI", "Z2MxOg", "Z2MxOi0x", "Z2MxOjEuNQ", "!!!", 5, null]) {
    assert.throws(() => decodeCursor(bad), (e) => e.code === "bad-cursor", String(bad));
  }
});

test("canonicalJson sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test("entityKeyFromArgs: identifying arguments, in a fixed priority order", () => {
  assert.equal(entityKeyFromArgs({ id: 5 }), "5");
  assert.equal(entityKeyFromArgs({ id: "abc" }), "abc");
  assert.equal(entityKeyFromArgs({ slug: "hello", other: 1 }), "hello");
  assert.equal(entityKeyFromArgs({ email: "a@b.c", id: 7 }), "7");
  assert.equal(entityKeyFromArgs({ uuid: "u" }), "u");
  assert.equal(entityKeyFromArgs({ sku: "S1" }), "S1");
  assert.equal(entityKeyFromArgs({ handle: "h" }), "h");
  assert.equal(entityKeyFromArgs({ username: "u" }), "u");
  assert.equal(entityKeyFromArgs({ key: { b: 1, a: 2 } }), '{"a":2,"b":1}');
  assert.equal(entityKeyFromArgs({ first: 3, status: "x" }), undefined);
  assert.equal(entityKeyFromArgs({ id: null }), undefined);
});

test("entityKeyFromArgs: composite keys join with 0x1E", () => {
  assert.equal(entityKeyFromArgs({ orgId: 1, userId: 2 }, ["orgId", "userId"]), "1\x1e2");
  assert.equal(entityKeyFromArgs({ userId: 2, orgId: 1 }, ["orgId", "userId"]), "1\x1e2");
  assert.equal(entityKeyFromArgs({ orgId: 1 }, ["orgId", "userId"]), undefined);
});

test("argsKeyOf excludes paging arguments and is order independent", () => {
  assert.equal(argsKeyOf({ status: "OPEN", first: 3, after: "x", offset: 1, limit: 2, page: 1, pageSize: 3, skip: 1, take: 1, last: 1, before: "b", cursor: "c", perPage: 4 }), '{"status":"OPEN"}');
  assert.equal(argsKeyOf({ a: 1, b: 2 }), argsKeyOf({ b: 2, a: 1 }));
  assert.equal(argsKeyOf({ first: 3 }), "");
  assert.equal(argsKeyOf({ x: undefined }), "");
});
