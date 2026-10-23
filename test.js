import { test } from "node:test";
import assert from "node:assert";
import generateMockData from "./index.js";

test("generateMockData generates mock data for a simple query", async (t) => {
  const query = `
    query {
      user {
        id
        name
        email
        age
      }
    }
  `;

  const result = generateMockData(query);

  assert.ok(result.user);
  assert.ok(typeof result.user.id === "string");
  assert.ok(typeof result.user.name === "string");
  assert.ok(typeof result.user.email === "string");
  assert.ok(typeof result.user.age === "number");
});

test("generateMockData handles nested fields", async (t) => {
  const query = `
    query {
      user {
        id
        name
        address {
          street
          city
          country
        }
      }
    }
  `;

  const result = generateMockData(query);

  assert.ok(result.user);
  assert.ok(typeof result.user.id === "string");
  assert.ok(typeof result.user.name === "string");
  assert.ok(result.user.address);
  assert.ok(typeof result.user.address.street === "string");
  assert.ok(typeof result.user.address.city === "string");
  assert.ok(typeof result.user.address.country === "string");
});
