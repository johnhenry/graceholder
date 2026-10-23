import { test } from "node:test";
import assert from "node:assert/strict";
import { graceholder } from "../src/index.js";

const PREFIX = "data:image/svg+xml;charset=utf-8,";
const decode = (uri) => {
  assert.ok(uri.startsWith(PREFIX), uri.slice(0, 60));
  return decodeURIComponent(uri.slice(PREFIX.length));
};

/** A strict-enough XML check: balanced tags, quoted attributes, only the five entities, no external references. */
function assertWellFormedSvg(svg) {
  assert.ok(svg.startsWith("<svg "), "starts with <svg");
  assert.ok(svg.endsWith("</svg>"), "ends with </svg>");
  assert.ok(!/<script|<image|<use|<foreignObject|href=|url\(|@import|on\w+=/i.test(svg), "no scripts or external references");
  assert.ok(!/https?:/.test(svg.replace("http://www.w3.org/2000/svg", "")), "no network URLs besides the namespace");
  const stack = [];
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z:-]+='[^'<&]*')*)\s*(\/?)>/g;
  let pos = 0;
  let m;
  while ((m = tag.exec(svg))) {
    const between = svg.slice(pos, m.index);
    assert.ok(!/[<>]/.test(between) && !/&(?!amp;|lt;|gt;|apos;|quot;)/.test(between), `text between tags is escaped: ${between}`);
    pos = tag.lastIndex;
    const [, close, name, , selfClose] = m;
    if (close) assert.equal(stack.pop(), name, `closing ${name}`);
    else if (!selfClose) stack.push(name);
  }
  assert.equal(pos, svg.length, "the whole string was tags and text");
  assert.deepEqual(stack, [], "all tags closed");
  assert.match(svg, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' width='\d+' height='\d+' viewBox='0 0 \d+ \d+'/);
}

const Q = "{ users(first: 40) { id firstName lastName avatar thumbnail } }";

test("images: default is unchanged example URLs; svg gives inline data URIs", () => {
  const url = graceholder(Q).users;
  assert.ok(url.every((u) => /^https:\/\/images\.example\.org\/[0-9a-f]{12}\.png$/.test(u.avatar)));
  const svg = graceholder(Q, { images: "svg" }).users;
  for (const u of svg) {
    assert.ok(u.avatar.startsWith(PREFIX) && u.thumbnail.startsWith(PREFIX));
    assertWellFormedSvg(decode(u.avatar));
    assertWellFormedSvg(decode(u.thumbnail));
  }
  assert.throws(() => graceholder(Q, { images: "png" }), (e) => e.code === "bad-options");
});

test("svg images are deterministic, per value, and independent of the other selected fields", () => {
  const a = graceholder(Q, { images: "svg", seed: "x" });
  assert.equal(JSON.stringify(a), JSON.stringify(graceholder(Q, { images: "svg", seed: "x" })));
  const b = graceholder("{ users(first: 40) { thumbnail avatar id } }", { images: "svg", seed: "x" });
  assert.deepEqual(a.users.map((u) => u.avatar), b.users.map((u) => u.avatar));
  assert.deepEqual(a.users.map((u) => u.thumbnail), b.users.map((u) => u.thumbnail));
  assert.notEqual(JSON.stringify(a), JSON.stringify(graceholder(Q, { images: "svg", seed: "y" })));
  assert.ok(new Set(a.users.map((u) => u.thumbnail)).size > 30, "geometric placeholders vary");
});

test("initials avatars show the initials of the entity's own name", () => {
  const { users } = graceholder(Q, { images: "svg" });
  for (const u of users) {
    const svg = decode(u.avatar);
    const initials = `${u.firstName[0]}${u.lastName[0]}`.toUpperCase();
    assert.ok(svg.includes(`>${initials}</text>`), `${u.firstName} ${u.lastName} -> ${svg}`);
    assert.ok(svg.includes(`aria-label='${initials}'`));
  }
});

test("avatars of organizations use the organization's name; other image fields are geometric", () => {
  const out = graceholder("{ companies(first: 5) { name logo avatar } }", { images: "svg" }).companies;
  for (const c of out) {
    assertWellFormedSvg(decode(c.avatar));
    assert.match(decode(c.avatar), /<text[^>]*>[A-Z]{2}<\/text>/);
    assert.ok(!decode(c.logo).includes("<text"), "logo is geometric");
    assert.ok(decode(c.logo).includes("<circle") || decode(c.logo).includes("<rect") || decode(c.logo).includes("<polygon"));
  }
});

test("explicit generators and sizes", () => {
  const spec = { "users.avatar": { gen: { name: "image.avatar", args: { size: 64 } } }, "users.thumbnail": { gen: { name: "image.geometric", args: { width: 100, height: 50 } } } };
  const { users } = graceholder("{ users(first: 3) { avatar thumbnail } }", { spec });
  for (const u of users) {
    assert.match(decode(u.avatar), /width='64' height='64' viewBox='0 0 64 64'/);
    assert.match(decode(u.thumbnail), /width='100' height='50' viewBox='0 0 100 50'/);
  }
  const bad = { "users.avatar": { gen: { name: "image.avatar", args: { size: 4 } } } };
  assert.throws(() => graceholder("{ users { avatar } }", { spec: bad }), (e) => e.code === "bad-generator-args");
});

test("the data URI contains no characters that need escaping in an attribute or a CSS url()", () => {
  const { users } = graceholder(Q, { images: "svg" });
  for (const u of users) assert.ok(!/["<>#\s{}|\\^`]/.test(u.avatar), u.avatar);
});
