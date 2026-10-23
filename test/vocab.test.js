import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { en, LOCALES } from "../src/vocab/en.js";

// SHA-256 of JSON.stringify(table). Any change here is an output change (docs/design.md 7.1, 11).
const CHECKSUMS = 
{
  "firstNames": "a1697e7f7a9c70b1c1d5aca31514820d9f55f58306baeb89ce9583cc6c9f26fb",
  "lastNames": "335194e1d565a8ce3c7e614e0787f977f3582a089360b01fe3793a6b67d2a9f9",
  "emailDomains": "86a92a321e1bd9b8d3d1834c8ec69c3a1abb943562f661e746e76da9a7faebcc",
  "tlds": "d406178d0c43f8bd6e2b78c049a094c1624905929a9858fd61af0fd5dc616f76",
  "places": "994e1e01d8d2474aabcccf0477c395d9e90bbff12edaf3ca5932988a22785ec1",
  "streets": "a8808b57ffc0ee5102f7c810cc5cadaf613fb4055d729fa1102700cdf1bd52bd",
  "streetSuffixes": "a2ae37c3e7a3a91a7fc1a053c1b6588b20977ae0a29a7dc01ce23ca2463d6395",
  "jobTitles": "ab8ac57365d2f15c15be883a30037e86aa1e7bf1ff8984a3ea21ccdc6ef7c428",
  "industries": "b57b17ae67d2584e57c0797afe4730223be36ac0218251ebc611ee8060fa7dbb",
  "companyHeads": "4c7555a19a3200bbadabfcc938b436fc06caa1ed92e484da1cc82d69e64237c5",
  "companySuffixes": "f2eed7998dd3041034144ab7898989836faca242d21b7ad648b1b4957a9f3aea",
  "productAdjectives": "6d3da7b061dc09acb09fd1bb2c212f35b3dfa1d5fa35cf1a77bb3a371c4f9349",
  "productNouns": "32bb1a32a44b905c98bf93f854d550bf3185bd782cd9208bd6b7dcc9b122547d",
  "words": "ab2f9abe1d6fa8b3bb0e6653c649b8c78285d84f4c129a7799a1bbb840aa2a6e",
  "status": "9105d7f0bb0c622809df629ffb4e689ed2a780b2aa223b5f4eec3a3b534acf9b",
  "role": "caf3dc839d0ed4209c1cdc40b4b52154bbd7766073162829c228008d34136ba7",
  "currency": "d27726abf821b883089c7aa48c69bdadbd9859ef2cb4058f09501cf39fbebd04",
  "locale": "cf7541361b031d1f45b68f91e2c447e9093125ee73640995c43625fea1409ff9",
  "language": "583a8c12b768f6994d7f5ac4693090b22ed7268802fec5fd3bf46b91ee9a9256",
  "colors": "52433134b567b50537de2df3d0897075062fd6c34eddab4262babdc38431f054"
};

test("vocabulary checksums (order-frozen tables)", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(CHECKSUMS).sort());
  for (const [name, expected] of Object.entries(CHECKSUMS)) {
    const actual = createHash("sha256").update(JSON.stringify(en[name])).digest("hex");
    assert.equal(actual, expected, `table ${name} changed`);
  }
});

test("vocabulary tables are frozen and non-empty, entries unique where required", () => {
  assert.ok(Object.isFrozen(en));
  for (const [name, table] of Object.entries(en)) {
    assert.ok(Object.isFrozen(table), name);
    assert.ok(table.length > 0, name);
  }
  for (const name of ["firstNames", "lastNames", "words", "status", "role"]) {
    // `words` has a deliberate duplicate-free requirement only for names and enums
    if (name === "words") continue;
    assert.equal(new Set(en[name]).size, en[name].length, name);
  }
  assert.equal(LOCALES.en, en);
});
