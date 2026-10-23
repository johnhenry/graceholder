import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, singularize, pascal, typeNameFor, personaKind } from "../src/naming.js";
import { listRule, classifyScalar, countOf } from "../src/rules.js";

test("tokenize: camelCase, snake_case, acronyms, digits", () => {
  const table = [
    ["createdAt", ["created", "at"]],
    ["user_id", ["user", "id"]],
    ["userID", ["user", "id"]],
    ["HTMLParser", ["html", "parser"]],
    ["blogPosts", ["blog", "posts"]],
    ["address2", ["address2"]],
    ["first-name", ["first", "name"]],
    ["id", ["id"]],
    ["_private", ["private"]],
  ];
  for (const [name, tokens] of table) assert.deepEqual(tokenize(name), tokens, name);
});

test("singularize: frozen rule table", () => {
  const table = [
    // irregular
    ["people", "person"], ["men", "man"], ["women", "woman"], ["children", "child"], ["mice", "mouse"],
    ["feet", "foot"], ["teeth", "tooth"], ["geese", "goose"], ["analyses", "analysis"], ["indices", "index"],
    ["criteria", "criterion"], ["knives", "knife"], ["wives", "wife"], ["leaves", "leaf"], ["lives", "life"],
    ["shelves", "shelf"], ["wolves", "wolf"], ["data", "data"],
    // ies -> y unless a vowel precedes, plus the -ie words
    ["stories", "story"], ["categories", "category"], ["movies", "movie"], ["cookies", "cookie"],
    // (sses|xes|ches|shes)
    ["boxes", "box"], ["addresses", "address"], ["watches", "watch"], ["dishes", "dish"],
    // ses / zes drop only the s
    ["cases", "case"], ["databases", "database"], ["houses", "house"], ["prizes", "prize"],
    // ss / us / is unchanged
    ["address", "address"], ["status", "status"], ["analysis", "analysis"], ["class", "class"],
    // trailing s
    ["posts", "post"], ["users", "user"], ["comments", "comment"], ["tags", "tag"],
    // already singular
    ["author", "author"], ["user", "user"],
  ];
  for (const [plural, one] of table) assert.equal(singularize(plural), one, plural);
});

test("pascal and typeNameFor (N3, N5)", () => {
  assert.equal(pascal(["blog", "post"]), "BlogPost");
  assert.equal(typeNameFor("blogPosts"), "BlogPost");
  assert.equal(typeNameFor("addresses"), "Address");
  assert.equal(typeNameFor("people"), "Person");
  assert.equal(typeNameFor("author"), "Author");
  assert.equal(typeNameFor("user_comments"), "UserComment");
  // N5: collisions with built-in scalars and root types
  assert.equal(typeNameFor("string"), "StringType");
  assert.equal(typeNameFor("id"), "Id"); // distinct from the ID scalar
  assert.equal(typeNameFor("query"), "QueryType");
  assert.equal(typeNameFor("dateTime"), "DateTimeType");
  assert.equal(typeNameFor("int"), "IntType");
});

test("personaKind by type-name token", () => {
  assert.equal(personaKind("User"), "person");
  assert.equal(personaKind("BlogAuthor"), "person");
  assert.equal(personaKind("Company"), "org");
  assert.equal(personaKind("Product"), "product");
  assert.equal(personaKind("Item"), "product");
  assert.equal(personaKind("Post"), "post");
  assert.equal(personaKind("Invoice"), "order");
  assert.equal(personaKind("Widget"), "generic");
});

// --- L rows -------------------------------------------------------------------

test("list/one table: each L row", () => {
  const none = { paging: false, idsArg: false, listLiteralArg: false };
  const table = [
    // L2 paging argument
    ["feed", { ...none, paging: true }, true, "L2"],
    // L3 plural
    ["posts", none, true, "L3"], ["users", none, true, "L3"], ["tags", none, true, "L3"],
    ["people", none, true, "L3"], ["children", none, true, "L3"], ["men", none, true, "L3"],
    ["women", none, true, "L3"], ["mice", none, true, "L3"],
    // L3 exclusions: ss / us / is endings and `data`
    ["address", none, false, "L6"], ["status", none, false, "L6"], ["analysis", none, false, "L6"],
    ["class", none, false, "L6"], ["data", none, false, "L6"],
    // plural words that are really singular count-like scalars
    ["views", none, false, "L6"], ["likes", none, false, "L6"], ["votes", none, false, "L6"], ["news", none, false, "L6"],
    // L4 specific names
    ["items", none, true, "L3"], ["nodes", none, true, "L3"], ["edges", none, true, "L3"], ["results", none, true, "L3"],
    ["list", none, true, "L4"], ["allData", none, true, "L4"], ["all_staff", none, true, "L4"], ["allUsers", none, true, "L3"],
    // L5 ids argument or list-literal argument
    ["usersByKey", { ...none, idsArg: true }, true, "L5"], ["pick", { ...none, listLiteralArg: true }, true, "L5"],
    // L6
    ["author", none, false, "L6"], ["user", none, false, "L6"], ["me", none, false, "L6"],
  ];
  for (const [name, ctx, list, rule] of table) {
    const r = listRule(name, ctx);
    assert.equal(r.list, list, `${name} list`);
    assert.equal(r.rule, rule, `${name} rule`);
  }
});

// --- T rows -------------------------------------------------------------------

const T = (name, type = "Thing", list = false) => classifyScalar(name, { typeName: type, list });

test("name-to-type table: T1 ids", () => {
  assert.deepEqual(T("id"), { sdl: "ID", gen: "id.key", args: {}, rule: "T1" });
  const r = T("userId");
  assert.equal(r.sdl, "ID");
  assert.equal(r.gen, "id.int");
  assert.deepEqual(r.args, { min: 1, max: 100, string: true });
  assert.equal(r.rule, "T1");
  assert.equal(T("ids", "Thing", true).sdl, "ID");
});

test("name-to-type table: T3 email, T4 url, T5 image, T6 phone", () => {
  for (const n of ["email", "workEmail", "emailAddress", "mail"]) assert.deepEqual([T(n).gen, T(n).rule], ["person.email", "T3"], n);
  assert.equal(T("emails", "Thing", true).gen, "person.email");
  for (const n of ["url", "uri", "link", "website", "homepage", "profileUrl", "siteUrl"]) assert.deepEqual([T(n).gen, T(n).rule], ["url", "T4"], n);
  for (const n of ["avatar", "image", "photo", "thumbnail", "picture", "logo", "avatarUrl", "imageUrl", "logoUrl"]) assert.deepEqual([T(n).gen, T(n).rule], ["imageUrl", "T5"], n);
  for (const n of ["phone", "mobile", "tel", "homePhone"]) assert.deepEqual([T(n).gen, T(n).rule], ["person.phone", "T6"], n);
});

test("name-to-type table: T7 booleans", () => {
  for (const n of ["isAdmin", "hasChildren", "canEdit", "shouldNotify", "wasSent", "didFinish", "allowComments", "enabled", "isActive", "active", "verified", "public", "deleted", "archived", "flag", "emailVerified"]) {
    const r = T(n);
    assert.deepEqual([r.sdl, r.gen, r.rule], ["Boolean", "bool", "T7"], n);
  }
  // `hash` and `issue` are not is/has prefixes (token based)
  assert.notEqual(T("hash").rule, "T7");
  assert.notEqual(T("issue").rule, "T7");
});

test("name-to-type table: T8 integers with frozen ranges", () => {
  const table = [
    ["commentCount", 0, 500], ["count", 0, 500], ["qty", 1, 10], ["quantity", 1, 10], ["num", 1, 100], ["age", 18, 90],
    ["year", 1990, 2024], ["index", 0, 99], ["position", 1, 20], ["rank", 1, 100], ["level", 1, 50], ["size", 1, 100],
    ["length", 1, 100], ["views", 0, 100000], ["likes", 0, 5000], ["votes", 0, 1000], ["total", 0, 1000],
    ["itemTotal", 0, 1000],
  ];
  for (const [n, min, max] of table) {
    const r = T(n);
    assert.deepEqual([r.sdl, r.gen, r.rule, r.args.min, r.args.max], ["Int", "int", "T8", min, max], n);
  }
  assert.equal(T("numberOfSeats").rule, "T8");
  // a type context overrides `total`
  for (const type of ["Order", "Invoice", "Cart", "Payment", "Receipt"]) {
    const r = T("total", type);
    assert.deepEqual([r.sdl, r.gen, r.rule], ["Float", "order.total", "T9"], type);
  }
});

test("name-to-type table: T9 floats", () => {
  const names = ["price", "cost", "amount", "subtotal", "tax", "fee", "balance", "salary", "revenue", "rate", "ratio", "score", "rating", "weight", "height", "lat", "lng", "latitude", "longitude", "percent", "unitPrice"];
  for (const n of names) {
    const r = T(n);
    assert.equal(r.sdl, "Float", n);
    assert.equal(r.rule, "T9", n);
    assert.ok(["money", "float"].includes(r.gen), n);
    assert.ok(r.args.max > r.args.min, n);
  }
  assert.equal(T("price").gen, "money");
  assert.equal(T("latitude").gen, "float");
  assert.deepEqual([T("latitude").args.min, T("latitude").args.max], [-90, 90]);
  assert.deepEqual([T("longitude").args.min, T("longitude").args.max], [-180, 180]);
});

test("name-to-type table: T10 dates", () => {
  const table = [
    ["createdAt", "time.created"], ["updatedAt", "time.updated"], ["publishedAt", "time.published"],
    ["startDate", "datetime"], ["date", "datetime"], ["time", "datetime"], ["timestamp", "datetime"], ["lastSeenAt", "datetime"],
    ["birthday", "time.birthday"], ["dob", "time.birthday"],
  ];
  for (const [n, gen] of table) {
    const r = T(n);
    assert.deepEqual([r.sdl, r.gen, r.rule], ["DateTime", gen, "T10"], n);
  }
  const d = T("deletedAt");
  assert.deepEqual([d.sdl, d.gen, d.nullable], ["DateTime", "time.deleted", true]);
  assert.equal(T("createdAt").nullable, undefined);
});

test("persona and order contexts", () => {
  assert.equal(classifyScalar("age", { typeName: "User", list: false }).gen, "person.age");
  assert.equal(classifyScalar("age", { typeName: "Widget", list: false }).gen, "int");
  for (const n of ["subtotal", "tax", "total"]) assert.equal(classifyScalar(n, { typeName: "Order", list: false }).gen, `order.${n}`);
  assert.equal(classifyScalar("subtotal", { typeName: "Widget", list: false }).gen, "money");
});

test("countOf: <x>Count and total<X>s name a sibling collection", () => {
  assert.deepEqual(countOf("commentCount"), ["comment"]);
  assert.deepEqual(countOf("commentsCount"), ["comment"]);
  assert.deepEqual(countOf("blogPostCount"), ["blog", "post"]);
  assert.deepEqual(countOf("categoryCount"), ["category"]);
  assert.deepEqual(countOf("totalComments"), ["comment"]);
  assert.equal(countOf("count"), null);
  assert.equal(countOf("totalCount"), null);
  assert.equal(countOf("totalPrice"), null);
  assert.equal(countOf("totalViews"), null);
  assert.equal(countOf("name"), null);
});

test("name-to-type table: T11 named strings", () => {
  const table = [
    ["firstName", "Thing", "person.first"], ["lastName", "Thing", "person.last"], ["fullName", "Thing", "person.full"],
    ["name", "User", "person.full"], ["name", "Thing", "person.full"], ["name", "Company", "company.name"],
    ["name", "Team", "company.name"], ["name", "Organization", "company.name"], ["name", "Brand", "company.name"],
    ["name", "Product", "product.name"], ["name", "Item", "product.name"],
    ["username", "Thing", "person.username"], ["handle", "Thing", "person.username"], ["nickname", "Thing", "person.username"],
    ["title", "Post", "title"], ["title", "Thing", "title"], ["title", "User", "person.jobTitle"], ["jobTitle", "Thing", "person.jobTitle"],
    ["company", "Thing", "company.name"], ["organization", "Thing", "company.name"],
    ["city", "Thing", "place.city"], ["state", "Thing", "place.state"], ["country", "Thing", "place.country"],
    ["zip", "Thing", "place.zip"], ["postalCode", "Thing", "place.zip"], ["street", "Thing", "place.street"],
    ["address", "Thing", "place.address"],
    ["bio", "Thing", "person.bio"], ["description", "Thing", "sentence"], ["summary", "Thing", "sentence"],
    ["body", "Thing", "paragraph"], ["content", "Thing", "paragraph"], ["text", "Thing", "sentence"],
    ["comment", "Thing", "sentence"], ["message", "Thing", "sentence"], ["slug", "Thing", "slug"],
    ["status", "Thing", "oneOf"], ["role", "Thing", "oneOf"], ["color", "Thing", "color"], ["currency", "Thing", "oneOf"],
    ["locale", "Thing", "oneOf"], ["language", "Thing", "oneOf"], ["uuid", "Thing", "id.uuid"], ["ip", "Thing", "ip"],
    ["sku", "Thing", "pattern"], ["token", "Thing", "hex"],
  ];
  for (const [n, type, gen] of table) {
    const r = T(n, type);
    assert.deepEqual([r.sdl, r.gen, r.rule], ["String", gen, "T11"], `${type}.${n}`);
  }
  assert.equal(T("status").args.vocab, "status");
  assert.equal(T("role").args.vocab, "role");
});

test("name-to-type table: T13 fallthrough", () => {
  for (const n of ["foo", "widgetThing", "tags"]) {
    const r = T(n, "Thing", n === "tags");
    assert.deepEqual([r.sdl, r.gen, r.rule], ["String", "words", "T13"], n);
    assert.deepEqual(r.args, { n: 2 });
  }
});

test("precedence: first matching row wins", () => {
  assert.equal(T("userEmail").rule, "T3"); // before T11
  assert.equal(T("createdAt").rule, "T10"); // before T11
  assert.equal(T("isPublic").rule, "T7"); // before T8-T13
  assert.equal(T("imageCount").rule, "T8"); // `image` only wins with a url/src/link suffix
  assert.equal(T("totalPrice").rule, "T9");
  assert.equal(T("__typename").rule, "T2");
});
