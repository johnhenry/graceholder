import { test } from "node:test";
import assert from "node:assert/strict";
import { stream, toNDJSON, toCSV, toSQL, sqlWriter, createWorld, GraceholderError } from "../src/index.js";

const join = (it) => [...it].join("");
const collect = async (it) => {
  let out = "";
  for await (const x of it) out += x;
  return out;
};

// ---- NDJSON ----------------------------------------------------------------------------------

test("toNDJSON: one compact JSON document per line, parseable back to the items", () => {
  const s = stream(`{ users { id name email tags posts { id title } } }`, { seed: "n", count: 25 });
  const text = join(toNDJSON(s));
  const lines = text.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 25);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [...s]);
  assert.ok(lines.every((l) => !l.includes("\n")));
});

test("toNDJSON is byte-identical across runs and chunked generation equals a single run", () => {
  const q = `{ users { id name } }`;
  const single = join(toNDJSON(stream(q, { seed: "n", count: 2000 })));
  assert.equal(join(toNDJSON(stream(q, { seed: "n", count: 2000 }))), single);
  const chunked = join(toNDJSON(stream(q, { seed: "n", count: 1000 }))) + join(toNDJSON(stream(q, { seed: "n", count: 1000, offset: 1000 })));
  assert.equal(chunked, single);
  assert.equal(join(toNDJSON(stream(q, { seed: "n", count: 2000, chunkSize: 37 }))), single);
});

test("toNDJSON takes any iterable or async iterable, and is async for an async-only source", async () => {
  assert.equal(join(toNDJSON([{ a: 1 }, { b: "x\ny" }])), '{"a":1}\n{"b":"x\\ny"}\n');
  async function* gen() {
    yield { a: 1 };
    yield { a: 2 };
  }
  assert.equal(await collect(toNDJSON(gen())), '{"a":1}\n{"a":2}\n');
  assert.equal(await collect(toNDJSON(stream(`{ users { id } }`, { seed: "n", count: 3 }))), join(toNDJSON(stream(`{ users { id } }`, { seed: "n", count: 3 }))));
  assert.throws(() => toNDJSON(42), (e) => e instanceof GraceholderError && e.code === "bad-options");
});

// ---- CSV -------------------------------------------------------------------------------------

test("toCSV: RFC 4180 quoting, CRLF, flattened column paths", () => {
  const rows = [
    { id: 1, name: 'Ada "the" Countess', note: "line one\nline two", address: { city: "London, UK", zip: null }, tags: ["a", "b"], ok: true },
    { id: 2, name: "", note: null, address: null, tags: [], ok: false },
  ];
  const text = join(toCSV(rows));
  assert.equal(
    text,
    'id,name,note,address.city,address.zip,tags,ok\r\n' +
      '1,"Ada ""the"" Countess","line one\nline two","London, UK",,"[""a"",""b""]",true\r\n' +
      '2,"",,,,[],false\r\n',
  );
});

test("toCSV options: delimiter, eol, header, columns", () => {
  const rows = [{ a: "x;y", b: "p,q", c: 3 }];
  assert.equal(join(toCSV(rows, { delimiter: ";", eol: "\n" })), 'a;b;c\n"x;y";p,q;3\n');
  assert.equal(join(toCSV(rows, { delimiter: "\t", header: false, eol: "\n" })), "x;y\tp,q\t3\n");
  assert.equal(join(toCSV(rows, { columns: ["c", "a"], eol: "\n" })), "c,a\n3,x;y\n");
  for (const bad of [{ delimiter: "" }, { delimiter: ";;" }, { delimiter: '"' }, { delimiter: "\n" }, { eol: "x" }, { lists: "nope" }, { columns: "a" }]) {
    assert.throws(() => toCSV(rows, bad), (e) => e.code === "bad-options", JSON.stringify(bad));
  }
});

test("toCSV from a stream: static columns from the query, nested objects flattened, lists JSON-encoded", () => {
  const q = `{ users @count(n: 4) { id name address { city } posts { id title } tags } }`;
  const text = join(toCSV(stream(q, { seed: "c", packs: [] }), { eol: "\n" }));
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[0], "id,name,address.city,posts,tags");
  assert.equal(parseCsv(text, ",").length, 5);
  const items = [...stream(q, { seed: "c" })];
  const parsed = parseCsv(text, ",");
  assert.deepEqual(JSON.parse(parsed[1][3]), items[0].posts);
  assert.equal(parsed[2][2], items[1].address.city);
});

test("toCSV explode: one row per list element, cross product across exploded lists, empty lists keep the row", () => {
  const rows = [
    { id: 1, tags: ["a", "b"], posts: [{ t: "x" }, { t: "y" }, { t: "z" }] },
    { id: 2, tags: [], posts: [] },
  ];
  assert.equal(join(toCSV(rows, { lists: "explode", eol: "\n" })), "id,tags,posts.t\n1,a,x\n1,a,y\n1,a,z\n1,b,x\n1,b,y\n1,b,z\n2,,\n");
  assert.equal(join(toCSV(rows, { explode: ["posts"], eol: "\n" })), 'id,tags,posts.t\n1,"[""a"",""b""]",x\n1,"[""a"",""b""]",y\n1,"[""a"",""b""]",z\n2,[],\n');
});

test("toCSV: header only for an empty stream, async sources, byte-identical and chunked equals single", async () => {
  const q = `{ users @count(n: 0) { id name } }`;
  assert.equal(join(toCSV(stream(q, { seed: "c" }), { eol: "\n" })), "id,name\n");
  const big = `{ users { id name email address { city } tags } }`;
  const single = join(toCSV(stream(big, { seed: "c", count: 1500 })));
  const a = join(toCSV(stream(big, { seed: "c", count: 1000 })));
  const b = join(toCSV(stream(big, { seed: "c", count: 500, offset: 1000 }), { header: false }));
  assert.equal(a + b, single);
  async function* gen() {
    yield* stream(big, { seed: "c", count: 20 });
  }
  assert.equal(await collect(toCSV(gen())), join(toCSV(stream(big, { seed: "c", count: 20 }))));
});

test("toCSV round-trips awkward text through a real CSV parser", () => {
  const nasty = ['plain', 'with "quotes"', "comma, here", "multi\nline", "cr\r\nlf", " leading", "trailing ", "", "é ü 日本", "semi;colon", "'single'"];
  for (const delimiter of [",", ";", "\t", "|"]) {
    const text = join(toCSV(nasty.map((v, i) => ({ i, v })), { delimiter }));
    const parsed = parseCsv(text, delimiter);
    assert.deepEqual(parsed.slice(1).map((r) => r[1]), nasty, delimiter);
  }
});

/** A small RFC 4180 parser used to check the writer (not part of the library). */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => (row.push(field), (field = ""));
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"', (i += 2));
      else if (c === '"') (quoted = false, i++);
      else (field += c, i++);
    } else if (c === '"') (quoted = true, i++);
    else if (c === delimiter) (endField(), i++);
    else if (c === "\r" && text[i + 1] === "\n") (endField(), rows.push(row), (row = []), (i += 2));
    else if (c === "\n") (endField(), rows.push(row), (row = []), i++);
    else (field += c, i++);
  }
  if (field !== "" || row.length) (endField(), rows.push(row));
  return rows;
}

// ---- SQL --------------------------------------------------------------------------------------

const BLOG = `{ posts { id title views createdAt tags author { id name email } comments { id body author { id name } } } }`;
// node:sqlite needs Node 22.13+ (unflagged); older runtimes skip the tests that load SQL
const DatabaseSync = await import("node:sqlite").then((m) => m.DatabaseSync, () => null);
const sqliteTest = DatabaseSync ? test : test.skip;

sqliteTest("toSQL (sqlite) loads into node:sqlite and queries back what stream() generates", async () => {
  const items = [...stream(BLOG, { seed: "sql", count: 60 })];
  const db = new DatabaseSync(":memory:");
  db.exec(join(toSQL(BLOG, { seed: "sql", count: 60, dialect: "sqlite" })));
  assert.equal(db.prepare("select count(*) n from post").get().n, 60);
  const post = db.prepare("select * from post where id = 7").get();
  assert.equal(post.title, items[6].title);
  assert.equal(post.views, items[6].views);
  assert.deepEqual(JSON.parse(post.tags), items[6].tags);
  assert.equal(post.author_id, Number(items[6].author.id));
  const author = db.prepare("select * from author where id = ?").get(post.author_id);
  assert.equal(author.name, items[6].author.name);
  assert.equal(author.email, items[6].author.email);
  const comments = db.prepare("select * from comment where post_id = 7 order by _key").all();
  assert.equal(comments.length, items[6].comments.length);
  assert.deepEqual(comments.map((c) => c.body).sort(), items[6].comments.map((c) => c.body).sort());
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  // joins work
  const joined = db.prepare("select p.id pid, a.name from post p join author a on a.id = p.author_id order by p.id").all();
  assert.equal(joined.length, 60);
  assert.equal(joined[0].name, items[0].author.name);
  db.close();
});

sqliteTest("toSQL: no duplicate primary keys, one row per referenced entity, the same entity has the same values everywhere", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = join(toSQL(BLOG, { seed: "sql", count: 300, dialect: "sqlite" }));
  db.exec(sql); // a duplicate primary key would throw here
  const referenced = new Set();
  for (const p of stream(BLOG, { seed: "sql", count: 300 })) {
    referenced.add(p.author.id);
    for (const c of p.comments) referenced.add(c.author.id);
  }
  assert.equal(db.prepare("select count(*) n from author").get().n, referenced.size);
  assert.ok(referenced.size <= 100, "references draw from the pool of 100");
  // the comment's author row is the post's author row when it is the same entity
  const everyone = new Map();
  for (const p of stream(BLOG, { seed: "sql", count: 300 })) {
    everyone.set(p.author.id, p.author);
    for (const c of p.comments) everyone.set(c.author.id, { ...everyone.get(c.author.id), ...c.author });
  }
  for (const row of db.prepare("select id, name, email from author").all()) {
    assert.equal(row.name, everyone.get(String(row.id)).name);
  }
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

sqliteTest("toSQL: the table of a type has the union of the columns selected anywhere, with the same values", async () => {
  // Author is selected with different fields at two places; email is only selected on posts.author
  const q = `{ posts { id author { id email } comments { id author { id name } } } }`;
  const w = sqlWriter(q, { count: 40, seed: "u", dialect: "sqlite" });
  const author = w.tables().find((t) => t.type === "Author");
  assert.deepEqual(author.columns.map((c) => c.name), ["id", "email", "name"]);
  const db = new DatabaseSync(":memory:");
  db.exec(join(toSQL(q, { count: 40, seed: "u", dialect: "sqlite" })));
  assert.equal(db.prepare("select count(*) n from author where email is null or name is null").get().n, 0);
  db.close();
});

test("toSQL: chunked output equals a single run (one writer, and independent writers that replay)", () => {
  const opts = { seed: "sql", count: 200, dialect: "sqlite" };
  const single = join(toSQL(BLOG, opts));
  const w = sqlWriter(BLOG, opts);
  assert.equal(w.header() + join(w.rows(0, 70)) + join(w.rows(70, 150)) + join(w.rows(150, 200)) + w.footer(), single);
  // an independent writer for the second part: replay brings its de-duplication state up to date
  const second = sqlWriter(BLOG, opts);
  const part2 = join(second.rows(70, 200));
  const first = sqlWriter(BLOG, opts);
  assert.equal(first.header() + join(first.rows(0, 70)) + part2 + first.footer(), single);
  // byte-identical across runs and independent of the window size
  assert.equal(join(toSQL(BLOG, opts)), single);
  assert.equal(join(toSQL(BLOG, { ...opts, chunkSize: 7 })), single);
  assert.throws(() => join(w.rows(10, 20)), (e) => e.code === "bad-options");
});

test("toSQL: statements are valid in both dialects and differ where they must", () => {
  const sqliteSql = join(toSQL(BLOG, { seed: "d", count: 3, dialect: "sqlite" }));
  const pgSql = join(toSQL(BLOG, { seed: "d", count: 3, dialect: "postgres" }));
  assert.match(pgSql, /^-- graceholder: postgres/);
  assert.match(pgSql, /CREATE TABLE "post" \(\n {2}"id" INTEGER PRIMARY KEY,\n {2}"title" TEXT,\n {2}"views" INTEGER,\n {2}"created_at" TIMESTAMPTZ,\n {2}"tags" JSONB,/);
  assert.match(pgSql, /ALTER TABLE "post" ADD CONSTRAINT "post_author_id_fkey" FOREIGN KEY \("author_id"\) REFERENCES "author" \("id"\) DEFERRABLE INITIALLY DEFERRED;/);
  assert.match(pgSql, /^BEGIN;$/m);
  assert.match(pgSql, /^COMMIT;$/m);
  assert.doesNotMatch(sqliteSql, /ALTER TABLE/);
  assert.match(sqliteSql, /"author_id" INTEGER REFERENCES "author" \("id"\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sqliteSql, /"created_at" TEXT/);
  assert.match(sqliteSql, /"tags" TEXT,/);
  assert.equal(pgSql.match(/^INSERT/gm).length, sqliteSql.match(/^INSERT/gm).length);
});

sqliteTest("toSQL: quoting and escaping of identifiers and strings, booleans per dialect", async () => {
  const spec = {
    "items.title": { pick: ["it's", 'say "hi"', "back\\slash", "new\nline", "100% ; DROP TABLE x; --", "日本語 émoji 🎉", ""] },
  };
  const query = `{ items @count(n: 14) { id title active } }`;
  const sqlLite = join(toSQL(query, { seed: "esc", spec: { ...spec, "items.active": { gen: "bool" } }, dialect: "sqlite" }));
  const sqlPg = join(toSQL(query, { seed: "esc", spec: { ...spec, "items.active": { gen: "bool" } }, dialect: "postgres" }));
  const expected = [...stream(query, { seed: "esc", spec: { ...spec, "items.active": { gen: "bool" } } })];
  const db = new DatabaseSync(":memory:");
  db.exec(sqlLite);
  const rows = db.prepare("select id, title, active from item order by id").all();
  assert.deepEqual(rows.map((r) => r.title), expected.map((e) => e.title));
  assert.deepEqual(rows.map((r) => r.active), expected.map((e) => (e.active ? 1 : 0)));
  assert.match(sqlPg, /'it''s'/);
  assert.match(sqlPg, /'say "hi"'/);
  assert.match(sqlPg, /'back\\slash'/);
  assert.match(sqlPg, /\bTRUE\b|\bFALSE\b/);
  assert.match(sqlPg, /"active" BOOLEAN/);
  assert.match(sqlLite, /"active" INTEGER/);
  db.close();
});

test("toSQL options: ddl, dropExisting, transaction, header/footer, names, tablePrefix, tableNames", () => {
  const q = `{ blogPosts @count(n: 2) { id postTitle author { id } } }`;
  const base = { seed: "o", dialect: "sqlite" };
  const noDdl = join(toSQL(q, { ...base, ddl: false, transaction: false }));
  assert.doesNotMatch(noDdl, /CREATE|BEGIN|COMMIT/);
  assert.match(noDdl, /^INSERT INTO "blog_post" \("id", "post_title", "author_id"\)/m);
  const drop = join(toSQL(q, { ...base, dropExisting: true }));
  assert.match(drop, /DROP TABLE IF EXISTS "author";\nDROP TABLE IF EXISTS "blog_post";/);
  assert.match(join(toSQL(q, { ...base, dropExisting: true, dialect: "postgres" })), /DROP TABLE IF EXISTS "author" CASCADE;/);
  const kept = join(toSQL(q, { ...base, names: "preserve", tablePrefix: "stg_" }));
  assert.match(kept, /CREATE TABLE "stg_BlogPost" \(/);
  assert.match(kept, /"postTitle" TEXT/);
  assert.match(join(toSQL(q, { ...base, tableNames: { BlogPost: "posts", Author: "people" } })), /CREATE TABLE "posts"[\s\S]*CREATE TABLE "people"/);
  assert.equal(join(toSQL(q, { ...base, header: false, footer: false })).match(/^INSERT/gm).length, 4);
  assert.throws(() => toSQL(q, { dialect: "mysql" }), (e) => e.code === "bad-options");
  assert.throws(() => toSQL(q, { names: "camel" }), (e) => e.code === "bad-options");
});

sqliteTest("toSQL: owned nested lists get text keys from their entity keys; stable across runs", async () => {
  const q = `{ users @count(n: 5) { id name posts { id title comments { id body } } } }`;
  const sql = join(toSQL(q, { seed: "own", dialect: "sqlite" }));
  assert.equal(join(toSQL(q, { seed: "own", dialect: "sqlite" })), sql);
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const keys = db.prepare("select _key k, user_id from post order by _key").all();
  assert.ok(keys.length >= 15);
  assert.ok(keys.every((r) => /^\d+\.posts\.\d+$/.test(r.k) && r.k.startsWith(`${r.user_id}.`)));
  const comment = db.prepare("select _key k, post_id from comment limit 1").get();
  assert.ok(comment.k.startsWith(`${comment.post_id}.comments.`));
  // the user's own id column is its key
  assert.deepEqual(db.prepare("select id from user order by id").all().map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

sqliteTest("toSQL: a world's pins and mutations are in the SQL", async () => {
  const w = createWorld({ seed: "ws" });
  const q = `{ posts { id title author { id name } } }`;
  const authorId = [...stream(q, { seed: "ws", count: 1 })][0].author.id;
  w.pin(`Author:${authorId}`, { name: "Pinned 'Author'" });
  w.pin("Post:2", { title: "A Pinned Title" });
  const db = new DatabaseSync(":memory:");
  db.exec(join(toSQL(w.stream(q, { count: 50 }), { dialect: "sqlite" })));
  assert.equal(db.prepare("select title from post where id = 2").get().title, "A Pinned Title");
  assert.equal(db.prepare("select name from author where id = ?").get(Number(authorId)).name, "Pinned 'Author'");
  assert.equal(db.prepare("select count(*) n from post").get().n, 50);
  db.close();
});

sqliteTest("toSQL works with schema mode and packs", async () => {
  const schema = `
    scalar DateTime
    enum Status { OPEN CLOSED }
    type Query { tickets(offset: Int, first: Int): [Ticket!]! }
    type Ticket { id: ID! subject: String! status: Status! opened: DateTime! labels: [String!]! owner: Person! score: Float }
    type Person { id: ID! name: String! }`;
  const q = `{ tickets { id subject status opened labels owner { id name } score } }`;
  const db = new DatabaseSync(":memory:");
  db.exec(join(toSQL(q, { seed: "sm", schema, count: 40, dialect: "sqlite" })));
  const items = [...stream(q, { seed: "sm", schema, count: 40 })];
  const row = db.prepare("select * from ticket where id = 5").get();
  assert.equal(row.status, items[4].status);
  assert.equal(row.subject, items[4].subject);
  assert.equal(row.score, items[4].score);
  assert.ok(["OPEN", "CLOSED"].includes(row.status));
  db.close();
  const geo = join(toSQL(`{ shops @count(n: 5) { id name address { city country } } }`, { seed: "g", packs: [], dialect: "sqlite" }));
  assert.match(geo, /CREATE TABLE "address"/);
});

test("toSQL refuses shapes it cannot represent, with a clear error", () => {
  assert.throws(() => join(toSQL(`{ postsConnection { totalCount edges { node { id } } } }`, { count: 3 })), (e) => e.code === "bad-options" && /connection/i.test(e.message));
  assert.throws(() => join(toSQL(`{ users @count(n: 3) { id search { ... on Post { id } ... on Comment { id } } } }`, { count: 3 })), (e) => e.code === "bad-options");
  assert.throws(() => join(toSQL(`{ things @count(n: 3) { authorId author_id author { id } } }`, {})), (e) => e.code === "bad-options" && /two columns/.test(e.message));
});
