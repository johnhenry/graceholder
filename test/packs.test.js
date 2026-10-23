import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { graceholder, createWorld, inferSchema, registerPack, registeredPacks } from "../src/index.js";
import { geo, commerce, finance, health, allPacks } from "../src/packs/index.js";
import { mod97, makeIban, luhnDigit } from "../src/packs/finance.js";
import { resolvePacks } from "../src/pack-registry.js";

const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const run = (q, o = {}) => graceholder(q, { seed: "packs", ...o });

// SHA-256 of JSON.stringify(table). Any change here is an output change (docs/design.md 7.1, 11, 17).
const CHECKSUMS = {
  "geo": {
    "geoCountries": "9af22ac83cb6625a90b3aa02694098961c41879afafc90a92e73562cdb175d51",
    "geoCities": "028293bf653b89ff2d8bd2d2c2e7e8a18ad84c472ab0e973bc2c500986fd4f24"
  },
  "commerce": {
    "commerceCategories": "4f577d8272ac14a3d9445b07bfe32f2cd932d7bf8c4b738d5bc94b67a19e376d",
    "commerceBrands": "78c3a88667a6a1f7382fb0d0fc92ea7897a1eb5461681a7f8c27dec9f2a6ba6c",
    "commerceAdjectives": "6c72333a3b0593e7895f2cc4972d9265fc1a9c5899894db68bc1e26b99826cc1"
  },
  "finance": {
    "financeCountryCurrency": "b783db3c222736affa880c7fb89fb5fa3e06f9dec285c33cdb64e97fe43b8f69",
    "financeCurrencies": "f7342cdfa9adf97275a3045ca38326990796742b945384f95ad837ac128e4743",
    "financeIbanCountries": "65e9dcff0df37234224294d62653b10c9be509386c49ca140884664f4e7f267a",
    "financeAccountTypes": "d64ad6391954c48d4c982002a0b3b63be4c6f94dff5c8a1a0d75b9d12cf32439",
    "financeTransactionTypes": "f6fa55774cfb55da70b6bd28cd58b06a9b0894b4bcb6a38b84f266de2d39c8ba",
    "financeMerchants": "28b98fedca768dc1cd1571c9608a95bd35ff7467f95ed8959f5aee81dc92dc21"
  },
  "health": {
    "healthConditions": "206ce72c40008e89ecc0b357587952e71684ff78a74aac83a250591d7c1ca807",
    "healthDoses": "300a852a1427c2c2a74acfc2cdae49daeaa844affac4629cc870873603c0890e",
    "healthSeverities": "c65f7075c1efbc4f5fc31e495bc267106ef339ad154d9b76c7dddedebbeae6fe"
  }
};

test("pack vocabulary tables are frozen and checksummed", () => {
  for (const pack of allPacks) {
    assert.ok(Object.isFrozen(pack) && Object.isFrozen(pack.vocab), pack.name);
    assert.deepEqual(Object.keys(pack.vocab).sort(), Object.keys(CHECKSUMS[pack.name]).sort(), `${pack.name} tables`);
    for (const [table, rows] of Object.entries(pack.vocab)) {
      assert.ok(Object.isFrozen(rows) && rows.length > 0, table);
      assert.equal(sha(rows), CHECKSUMS[pack.name][table], `table ${table} changed`);
    }
  }
});

test("registry: names, objects, conflicts", () => {
  assert.throws(() => run("{ a { city } }", { packs: ["finance"] }), (e) => e.code === "unknown-pack" && /packs\/finance/.test(e.hint));
  assert.throws(() => run("{ a { city } }", { packs: "geo" }), (e) => e.code === "bad-options");
  assert.throws(() => run("{ a { city } }", { packs: [{ name: "Bad Name", generators() { return {}; } }] }), (e) => e.code === "bad-pack");
  assert.throws(() => registerPack({ name: "x" }), (e) => e.code === "bad-pack");
  registerPack(geo);
  registerPack(geo);
  // a different pack under a used name is refused
  assert.throws(() => resolvePacks([{ ...geo, generators: () => ({}) }]), (e) => e.code === "bad-pack" && /already in use/.test(e.message));
  assert.ok(registeredPacks().includes("geo"));
  assert.equal(run("{ user(id: 1) { city } }", { packs: ["geo"] }).user.city, run("{ user(id: 1) { city } }", { packs: [geo] }).user.city);
  // duplicates are ignored
  assert.deepEqual(resolvePacks([geo, "geo", geo]), [geo]);
});

test("without packs nothing changes: the placeholder places are still the default", () => {
  const out = run("{ users(first: 30) { city country timezone lat } }");
  assert.ok(out.users.every((u) => ["United States", "Canada"].includes(u.country)));
  assert.ok(out.users.every((u) => typeof u.timezone === "string" && !u.timezone.includes("/")), "timezone is just words without the pack");
});

// ---------------------------------------------------------------- geo

const COUNTRY_POSTAL = {
  US: /^\d{5}$/, CA: /^[A-Z]\d[A-Z] \d[A-Z]\d$/, GB: /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/, DE: /^\d{5}$/, FR: /^\d{5}$/, ES: /^\d{5}$/, IT: /^\d{5}$/,
  NL: /^\d{4} [A-Z]{2}$/, SE: /^\d{3} \d{2}$/, CH: /^\d{4}$/, AU: /^\d{4}$/, NZ: /^\d{4}$/, JP: /^\d{3}-\d{4}$/, BR: /^\d{5}-\d{3}$/,
  MX: /^\d{5}$/, IN: /^\d{6}$/, NG: /^\d{6}$/, ZA: /^\d{4}$/,
};
// rough bounding boxes [south, north, west, east] to catch coordinate typos
const BBOX = {
  US: [18.5, 71.5, -179, -66], CA: [41.5, 83, -141, -52], GB: [49.8, 61, -8.7, 1.9], DE: [47.2, 55.1, 5.8, 15.1], FR: [41.2, 51.2, -5.3, 9.7],
  ES: [35.8, 43.9, -9.4, 4.4], IT: [36.5, 47.1, 6.5, 18.6], NL: [50.7, 53.6, 3.3, 7.3], SE: [55.2, 69.1, 10.9, 24.2], CH: [45.8, 47.9, 5.9, 10.6],
  AU: [-44, -10, 112, 154], NZ: [-47.5, -34, 166, 179], JP: [30.9, 45.6, 129.4, 145.9], BR: [-33.8, 5.3, -74, -34.7], MX: [14.5, 32.8, -118.5, -86.6],
  IN: [6.7, 35.7, 68, 97.5], NG: [4.2, 13.9, 2.6, 14.7], ZA: [-35, -22, 16.4, 33],
};
const DIAL = Object.fromEntries(geo.vocab.geoCountries.map((c) => [c[0], c[2]]));

test("geo table is internally consistent (countries, bounding boxes, time zones, patterns)", () => {
  const codes = geo.vocab.geoCountries.map((c) => c[0]);
  assert.equal(new Set(codes).size, codes.length);
  const names = geo.vocab.geoCities.map((c) => `${c[0]}|${c[3]}`);
  assert.equal(new Set(names).size, names.length, "no duplicate city");
  assert.ok(geo.vocab.geoCities.length >= 100);
  for (const [city, region, , cc, lat, lng, tz, pc, ac] of geo.vocab.geoCities) {
    assert.ok(codes.includes(cc), `${city}: country ${cc}`);
    const [s, n, w, e] = BBOX[cc];
    assert.ok(lat >= s && lat <= n && lng >= w && lng <= e, `${city} (${lat}, ${lng}) is outside ${cc}`);
    assert.ok(region && pc && ac, city);
    // the time zone exists, and its offset roughly follows the longitude (15 degrees per hour)
    const parts = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date("2025-01-15T12:00:00Z"));
    const off = parts.find((p) => p.type === "timeZoneName").value;
    const m = /GMT([+-])(\d\d):(\d\d)/.exec(off);
    const hours = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 0;
    const bound = ["US", "CA", "AU", "NZ", "BR", "MX"].includes(cc) ? 50 : 40;
    assert.ok(Math.abs(lng - hours * 15) < bound, `${city}: lng ${lng} vs offset ${off} (${tz})`);
  }
  assert.deepEqual(Object.keys(BBOX).sort(), [...codes].sort());
});

const GEO_Q = `{ users(first: 400) { id city state country zip timezone countryCode regionCode callingCode phone latitude longitude lat lng
  address { city state country zip latitude longitude timezone } } }`;

test("geo coherence over 400 entities: city, region, country, coordinates, time zone, postal and phone agree", () => {
  const { users } = run(GEO_Q, { packs: [geo] });
  const rows = new Map(geo.vocab.geoCities.map((c) => [`${c[0]}|${c[1]}|${c[3]}`, c]));
  const countryName = new Map(geo.vocab.geoCountries.map((c) => [c[1], c[0]]));
  const seen = new Set();
  for (const u of users) {
    const code = countryName.get(u.country);
    assert.ok(code, `known country ${u.country}`);
    const row = rows.get(`${u.city}|${u.state}|${code}`);
    assert.ok(row, `${u.city}, ${u.state}, ${u.country} is a row of the table`);
    seen.add(u.city);
    const [, , regionCode, , lat, lng, tz, pc, ac] = row;
    assert.equal(u.countryCode, code);
    assert.equal(u.regionCode, regionCode);
    assert.equal(u.timezone, tz);
    assert.equal(u.callingCode, `+${DIAL[code]}`);
    // coordinates: near the city
    for (const [a, b] of [[u.latitude, lat], [u.lat, lat]]) assert.ok(Math.abs(a - b) <= 0.1 + 1e-9, `${u.city} lat ${a} vs ${b}`);
    for (const [a, b] of [[u.longitude, lng], [u.lng, lng]]) assert.ok(Math.abs(a - b) <= 0.1 + 1e-9, `${u.city} lng ${a} vs ${b}`);
    assert.equal(u.latitude, u.lat);
    assert.equal(u.longitude, u.lng);
    // postal code: the country's format, starting with the city's prefix
    assert.match(u.zip, COUNTRY_POSTAL[code], `${u.city} postal ${u.zip}`);
    assert.ok(u.zip.startsWith(pc), `${u.zip} starts with ${pc}`);
    // phone: the country's calling code (and, for NANP numbers, the city's area code)
    assert.ok(u.phone.startsWith(`+${DIAL[code]} `), `${u.phone} for ${code}`);
    if (code === "US" || code === "CA") assert.match(u.phone, new RegExp(`^\\+1 ${ac}-555-01\\d\\d$`));
    if (code === "GB") assert.match(u.phone, /^\+44 (20 7946 0|\d{3} 496 0|29 2018 0|28 9649 6)\d{3}$/);
    if (code === "AU") assert.match(u.phone, /^\+61 \d 5550 \d{4}$/);
    assert.ok(!u.phone.includes("#") && !u.phone.includes("{"));
    // the nested address is the same place
    for (const k of ["city", "state", "country", "zip", "latitude", "longitude", "timezone"]) assert.equal(u.address[k], u[k], `address.${k}`);
  }
  assert.ok(seen.size > 60, `many different cities appear (${seen.size})`);
});

test("geo: street addresses use the country's layout and the same postal code as zip", () => {
  const { users } = run("{ users(first: 200) { country city zip fullAddress } }", { packs: [geo], spec: { "users.fullAddress": { gen: "place.address" } } });
  for (const u of users) {
    assert.ok(u.fullAddress.includes(u.zip), u.fullAddress);
    assert.ok(u.fullAddress.includes(u.city), u.fullAddress);
    if (u.country === "United States") assert.match(u.fullAddress, /^\d+ [A-Za-z]+ [A-Za-z]+, .+, [A-Z]{2} \d{5}$/);
  }
});

test("geo: a field's value is the same whatever else is selected (persona slots)", () => {
  const a = run("{ users(first: 30) { city phone zip } }", { packs: [geo] }).users;
  const b = run("{ users(first: 30) { zip email lat timezone phone city country } }", { packs: [geo] }).users;
  assert.deepEqual(a.map((u) => [u.city, u.phone, u.zip]), b.map((u) => [u.city, u.phone, u.zip]));
});

test("geo: an address inside an entity is owned by it (same place, never a shared pool entity)", () => {
  const out = run("{ users(first: 20) { id address { city } } orders(first: 20) { address { city } } }", { packs: [geo] });
  assert.equal(out.users.length, 20);
  // two users never collapse onto one shared Address entity by chance
  assert.ok(new Set(out.users.map((u) => u.address.city)).size > 5);
});

test("geo: explicit generator names work only with the pack, with a helpful error otherwise", () => {
  const spec = { "users.where": { gen: "geo.timezone" } };
  assert.throws(() => run("{ users { where } }", { spec }), (e) => e.code === "unknown-generator");
  const { users } = run("{ users(first: 5) { where city } }", { spec, packs: [geo] });
  assert.ok(users.every((u) => u.where.includes("/")));
});

// ---------------------------------------------------------------- commerce

test("commerce: category, brand, product name, SKU prefix and price band agree", () => {
  const { products } = run("{ products(first: 300) { name category brand sku price } }", { packs: [commerce] });
  const cats = new Map(commerce.vocab.commerceCategories.map((c) => [c[0], c]));
  const seen = new Set();
  for (const p of products) {
    const c = cats.get(p.category);
    assert.ok(c, p.category);
    seen.add(p.category);
    assert.ok(commerce.vocab.commerceBrands.includes(p.brand));
    assert.ok(p.name.startsWith(`${p.brand} `), `${p.name} / ${p.brand}`);
    assert.ok(c[4].some((noun) => p.name.endsWith(` ${noun}`)), `${p.name} is a ${p.category}`);
    assert.match(p.sku, new RegExp(`^${c[1]}-\\d{5}$`));
    assert.ok(p.price >= c[2] && p.price <= c[3], `${p.price} in ${c[2]}-${c[3]} for ${p.category}`);
    assert.equal(Math.round(p.price * 100) / 100, p.price);
  }
  assert.equal(seen.size, commerce.vocab.commerceCategories.length);
});

test("commerce: order totals do not depend on which item fields are selected", () => {
  const cents = (x) => Math.round(x * 100);
  const full = run("{ orders(first: 6) { subtotal tax total items { price quantity name } } }", { packs: [commerce] }).orders;
  const lean = run("{ orders(first: 6) { subtotal tax total } }", { packs: [commerce] }).orders;
  const priceOnly = run("{ orders(first: 6) { subtotal items { price } } }", { packs: [commerce] }).orders;
  full.forEach((o, i) => {
    assert.equal(cents(o.subtotal), o.items.reduce((s, it) => s + cents(it.price) * it.quantity, 0));
    assert.equal(o.subtotal, lean[i].subtotal);
    assert.equal(o.total, lean[i].total);
    assert.equal(o.subtotal, priceOnly[i].subtotal);
  });
});

// ---------------------------------------------------------------- finance

test("finance: IBAN check digits, lengths and layouts are valid (ISO 13616 mod 97)", () => {
  const { accounts } = run("{ accounts(first: 500) { iban bic } }", { packs: [finance] });
  const layouts = new Map(finance.vocab.financeIbanCountries.map((c) => [c[0], c[2]]));
  const lengths = { DE: 22, GB: 22, FR: 27, ES: 24, IT: 27, NL: 18, BE: 16, CH: 21, SE: 24, AT: 20, IE: 22, PL: 28, PT: 25, NO: 15 };
  const seen = new Set();
  for (const a of accounts) {
    const cc = a.iban.slice(0, 2);
    seen.add(cc);
    assert.ok(layouts.has(cc), cc);
    assert.equal(a.iban.length, lengths[cc], a.iban);
    assert.match(a.iban, /^[A-Z]{2}\d{2}[A-Z0-9]+$/);
    assert.equal(mod97(a.iban.slice(4) + a.iban.slice(0, 4)), 1, `${a.iban} fails mod 97`);
    // the BBAN follows its country layout
    let rest = a.iban.slice(4);
    for (const part of layouts.get(cc).split(",")) {
      const n = Number.parseInt(part, 10);
      const chunk = rest.slice(0, n);
      rest = rest.slice(n);
      assert.match(chunk, part.endsWith("n") ? /^\d+$/ : part.endsWith("a") ? /^[A-Z]+$/ : /^[A-Z0-9]+$/, `${a.iban} ${part}`);
    }
    assert.equal(rest, "");
    assert.match(a.bic, /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}$/);
    assert.equal(a.bic.slice(4, 6), cc);
  }
  assert.equal(seen.size, layouts.size, "every country appears");
});

test("finance: mod97 reproduces published example IBANs", () => {
  for (const iban of ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606", "NL91ABNA0417164300", "CH9300762011623852957", "ES9121000418450200051332"]) {
    assert.equal(mod97(iban.slice(4) + iban.slice(0, 4)), 1, iban);
  }
  assert.equal(makeIban("GB", "WEST12345698765432"), "GB82WEST12345698765432");
  assert.equal(makeIban("DE", "370400440532013000"), "DE89370400440532013000");
});

test("finance: card numbers pass Luhn, routing numbers pass the ABA checksum", () => {
  const { accounts } = run("{ accounts(first: 400) { cardNumber routingNumber accountNumber } }", { packs: [finance] });
  const nets = new Set();
  for (const a of accounts) {
    assert.match(a.cardNumber, /^\d{15,16}$/);
    assert.equal(luhnDigit(a.cardNumber.slice(0, -1)), Number(a.cardNumber.at(-1)), a.cardNumber);
    nets.add(a.cardNumber[0] === "4" ? "visa" : a.cardNumber[0] === "5" ? "mc" : "amex");
    if (a.cardNumber[0] === "3") assert.equal(a.cardNumber.length, 15);
    assert.match(a.routingNumber, /^\d{9}$/);
    const d = [...a.routingNumber].map(Number);
    assert.equal((3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10, 0, a.routingNumber);
    assert.ok(Number(a.routingNumber.slice(0, 2)) >= 1 && Number(a.routingNumber.slice(0, 2)) <= 12);
    assert.match(a.accountNumber, /^\d{8,12}$/);
  }
  assert.equal(nets.size, 3);
  // known valid Luhn numbers
  assert.equal(luhnDigit("411111111111111"), 1);
  assert.equal(luhnDigit("37828224631000"), 5);
});

test("finance: currency follows the IBAN country, and the geo pack's country when both are enabled", () => {
  const { accounts } = run("{ accounts(first: 100) { iban currency currencyName currencySymbol accountType transactionType merchant } }", { packs: [finance] });
  const byCountry = new Map(finance.vocab.financeIbanCountries.map((c) => [c[0], c[1]]));
  for (const a of accounts) {
    assert.equal(a.currency, byCountry.get(a.iban.slice(0, 2)));
    assert.ok(finance.vocab.financeCurrencies.some((c) => c[0] === a.currency && c[1] === a.currencyName && c[2] === a.currencySymbol));
    assert.ok(finance.vocab.financeAccountTypes.includes(a.accountType));
    assert.ok(finance.vocab.financeMerchants.includes(a.merchant));
  }
  const both = run("{ users(first: 200) { country countryCode iban currency } }", { packs: [geo, finance] }).users;
  const ccy = new Map(finance.vocab.financeCountryCurrency);
  for (const u of both) {
    assert.equal(u.currency, ccy.get(u.countryCode), `${u.country} -> ${u.currency}`);
    if (byCountry.has(u.countryCode)) assert.equal(u.iban.slice(0, 2), u.countryCode, "IBAN country is the user's country");
  }
  // pack order does not matter
  assert.deepEqual(both, run("{ users(first: 200) { country countryCode iban currency } }", { packs: [finance, geo] }).users);
});

// ---------------------------------------------------------------- health

test("health: clearly fictional conditions and medications, coherent per entity", () => {
  const { patients } = run("{ patients(first: 200) { condition medication dosage specialty severity mrn } }", { packs: [health] });
  const rows = new Map(health.vocab.healthConditions.map((r) => [r[0], r]));
  for (const p of patients) {
    assert.ok(p.condition.endsWith(" (fictional)") && p.medication.endsWith(" (fictional)"), `${p.condition} / ${p.medication}`);
    const r = rows.get(p.condition.replace(" (fictional)", ""));
    assert.ok(r, p.condition);
    assert.ok(r.slice(2).includes(p.medication.replace(" (fictional)", "")), "the medication treats the condition");
    assert.equal(p.specialty, r[1]);
    assert.ok(health.vocab.healthDoses.includes(p.dosage));
    assert.match(p.mrn, /^FX-\d{7}$/);
  }
  // the tag can be switched off; the names themselves still are not real
  const spec = { "patients.condition": { gen: { name: "health.condition", args: { tag: false } } } };
  assert.ok(run("{ patients(first: 20) { condition } }", { packs: [health], spec }).patients.every((p) => !p.condition.includes("(")));
});

test("health vocabulary contains no real-world drug or diagnosis names", () => {
  // a small deny list of well-known real names and common medical word endings; the pack must contain none
  const real = /\b(aspirin|ibuprofen|paracetamol|acetaminophen|amoxicillin|insulin|morphine|cancer|diabetes|asthma|covid|influenza|hypertension|depression|migraine|arthritis|eczema|measles|malaria|hiv|aids)\b/i;
  const medLike = /(cillin|mycin|prazole|statin|olol|pril|sartan|oxetine|zepam|codone|fentanyl)\b/i;
  for (const r of health.vocab.healthConditions) for (const name of [r[0], r[2], r[3]]) {
    assert.ok(!real.test(name) && !medLike.test(name), name);
  }
  assert.equal(new Set(health.vocab.healthConditions.map((r) => r[0])).size, health.vocab.healthConditions.length);
});

// ---------------------------------------------------------------- inference

test("pack rules are reported as rule P1 and lose to spec and directives", () => {
  const { decisions } = inferSchema("{ users { city timezone iban condition } }", {}, { packs: [geo, finance, health] });
  const rules = Object.fromEntries(decisions.filter((d) => d.kind === "scalar").map((d) => [d.field, d.rule]));
  assert.deepEqual(rules, { city: "T11", timezone: "P1", iban: "P1", condition: "P1" });
  const spec = { "users.iban": { pattern: "XX-####" } };
  assert.match(run("{ users(first: 1) { iban } }", { packs: [finance], spec }).users[0].iban, /^XX-\d{4}$/);
  assert.match(run('{ users(first: 1) { iban @pattern(p: "YY-##") } }', { packs: [finance] }).users[0].iban, /^YY-\d\d$/);
});

test("with no pack enabled, pack field names are ordinary words", () => {
  const out = run("{ users(first: 3) { iban condition timezone } }");
  assert.ok(out.users.every((u) => /^[a-z ]+$/.test(u.iban) && /^[a-z ]+$/.test(u.condition)));
});

test("the core invariant holds with every pack and realistic mode on", () => {
  const opts = { packs: allPacks, distributions: "realistic", images: "svg", seed: "inv" };
  const a = run("{ users(first: 15) { id city iban avatar viewCount condition createdAt } }", opts).users;
  const b = run("{ users(first: 15) { createdAt viewCount extra: viewCount avatar name condition iban id city } }", opts).users;
  a.forEach((u, i) => {
    for (const k of ["id", "city", "iban", "avatar", "viewCount", "condition", "createdAt"]) assert.equal(JSON.stringify(u[k]), JSON.stringify(b[i][k]), k);
    assert.equal(b[i].extra, u.viewCount);
  });
  // paging does not move entities
  const page = run("{ users(first: 5, offset: 10) { id city iban } }", opts).users;
  assert.deepEqual(page.map((u) => u.iban), a.slice(10).map((u) => u.iban));
  assert.deepEqual(page.map((u) => u.city), a.slice(10).map((u) => u.city));
});

test("every pack runs in strict browser-like conditions: no banned reads (also asserted by npm run lint)", async () => {
  const { findBanned } = await import("../scripts/check-banned.mjs");
  const { readFileSync } = await import("node:fs");
  for (const f of ["geo", "commerce", "finance", "health", "index"]) {
    assert.deepEqual(findBanned(readFileSync(new URL(`../src/packs/${f}.js`, import.meta.url), "utf8")), [], f);
  }
});

test("a world applies packs, images and distributions to every query, pins included, and exports them", () => {
  for (const pack of allPacks) registerPack(pack);
  const world = createWorld({ seed: "w", packs: [geo, "finance"], images: "svg", distributions: "realistic" });
  world.pin("User:1", { name: "Zed Quill" });
  const q = "{ user(id: 1) { name avatar city iban viewCount } }";
  const { data } = world.query(q);
  const direct = graceholder(q, { seed: "w", packs: [geo, finance], images: "svg", distributions: "realistic" }).user;
  assert.equal(data.user.name, "Zed Quill");
  assert.equal(decodeURIComponent(data.user.avatar).match(/>([A-Z]+)<\/text>/)[1], "ZQ", "the avatar shows the pinned name's initials");
  assert.equal(data.user.city, direct.city);
  assert.equal(data.user.iban, direct.iban);
  assert.equal(data.user.viewCount, direct.viewCount);
  const exported = world.export();
  assert.deepEqual([exported.packs, exported.images, exported.distributions], [["geo", "finance"], "svg", "realistic"]);
  assert.deepEqual(createWorld(exported).query(q).data, data);
  const plain = createWorld({ seed: "plain" }).export();
  assert.ok(!("packs" in plain) && !("images" in plain) && !("distributions" in plain), "defaults are not exported");
  assert.throws(() => createWorld({ images: "gif" }), (e) => e.code === "bad-options");
});
