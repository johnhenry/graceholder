// SQL seeding: INSERT statements (and optional DDL) for Postgres and SQLite. See docs/design.md section 19
// and docs/api.md "toSQL" for the table, key and foreign-key strategy.
import { GraceholderError } from "../errors.js";
import { planStream } from "./plan.js";
import { POOL_SIZE } from "../execute.js";
import { shapeOfDocument } from "./shape.js";

const bad = (msg, extra) => new GraceholderError("bad-options", msg, extra);
const DIALECTS = new Set(["postgres", "sqlite"]);
const NUMERIC = /^(0|[1-9][0-9]*)$/;

export const snake = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");

const quoteIdent = (id) => `"${String(id).replaceAll('"', '""')}"`;
const quoteText = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** Column SQL type for a GraphQL scalar. */
function sqlType(dialect, sdl, list) {
  const pg = dialect === "postgres";
  if (list) return pg ? "JSONB" : "TEXT";
  switch (sdl) {
    case "Int": return "INTEGER";
    case "Float": return pg ? "DOUBLE PRECISION" : "REAL";
    case "Boolean": return pg ? "BOOLEAN" : "INTEGER";
    case "DateTime": return pg ? "TIMESTAMPTZ" : "TEXT";
    case "Date": return pg ? "DATE" : "TEXT";
    default: return "TEXT";
  }
}

/** A SQL literal for a value in a column of kind `kind` ("int", "float", "bool", "json" or "text"). */
function literal(dialect, kind, value) {
  if (value === null || value === undefined) return "NULL";
  if (kind === "json" || (typeof value === "object")) return quoteText(JSON.stringify(value));
  if (kind === "bool") return dialect === "postgres" ? (value ? "TRUE" : "FALSE") : value ? "1" : "0";
  if (kind === "int" || kind === "float") {
    if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "0" : String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    return quoteText(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return quoteText(typeof value === "string" ? value : String(value));
}

const kindOf = (sdl, list) => (list ? "json" : sdl === "Int" ? "int" : sdl === "Float" ? "float" : sdl === "Boolean" ? "bool" : "text");

function pathString(path) {
  const parts = [];
  for (let p = path; p; p = p.prev) parts.push(p.key);
  return parts.reverse().join("/");
}

/**
 * Plan the tables of a shape: one per entity type, scalar columns, foreign keys and key kinds.
 */
function planTables(plan, shape) {
  const { inferred, runOptions } = plan;
  const model = inferred.model;
  const rootType = inferred.rootType ?? "Query";
  const world = runOptions.world;
  const packs = runOptions.packs ?? [];
  /** @type {Map<string, any>} */
  const tables = new Map();
  const tableOf = (node) => {
    let t = tables.get(node.typeName);
    if (!t) {
      t = { type: node.typeName, scalars: new Map(), singles: new Map(), lists: new Map(), text: false, dedupe: false, owners: [] };
      tables.set(node.typeName, t);
    }
    return t;
  };
  const rootInfo = plan.rootInfo;
  const rootField = inferred.document.definitions[0].selectionSet.selections[0];
  const rootArgs = (rootField.arguments ?? []).some((a) => !["offset", "first", "skip", "take", "limit", "after"].includes(a.name.value));
  const rootShared = rootInfo.own ? false : (rootInfo.shared ?? true);

  const visit = (node, siteShared, siteText) => {
    const t = tableOf(node);
    if (siteText) t.text = true;
    if (siteShared) t.dedupe = true;
    if (world?.touches(node.typeName)) t.text = true;
    for (const f of node.fields.values()) {
      const info = model.get(node.typeName)?.get(f.name);
      if (f.kind === "scalar") {
        const prev = t.scalars.get(f.name);
        if (!prev || (prev.key !== f.name && f.key === f.name)) t.scalars.set(f.name, { key: f.key, name: f.name, sdl: f.sdl, list: f.list, gen: f.gen });
        continue;
      }
      if (f.connection) throw bad("toSQL does not support Relay connections: select a plain list instead", { hint: `field ${f.name}` });
      if (inferred.abstracts.has(f.typeName)) throw bad("toSQL does not support union or interface fields", { hint: `field ${f.name}` });
      const hasArgs = f.args;
      if (f.list) {
        // nested lists are owned by their parent (text keys "<parent key>.<field>.<i>") unless declared shared
        const shared = info?.own ? false : (info?.shared ?? false);
        t.lists.set(f.name, { key: f.key, name: f.name, target: f.typeName, shared });
        visit(f.node, shared, !shared || hasArgs);
      } else {
        // a singular child is a reference into the type's shared pool unless it is owned (spec `own`, or a geo-style child)
        const own = Boolean(info?.own) || packs.some((p) => p.inherit?.(f.typeName));
        t.singles.set(f.name, { key: f.key, name: f.name, target: f.typeName, owned: own });
        visit(f.node, !own, own || hasArgs || Boolean(info?.keyArgs));
      }
    }
  };
  const rootNode = shape;
  visit(rootNode, rootShared, !rootShared || rootArgs);
  return tables;
}

/**
 * A resumable SQL writer: `header()`, then `rows(from, to)` in order, then `footer()`.
 * @param {any} source a query, or a `stream()`
 * @param {any} [options]
 */
export function sqlWriter(source, options = {}) {
  const dialect = options.dialect ?? "postgres";
  if (!DIALECTS.has(dialect)) throw bad(`dialect must be "postgres" or "sqlite", got ${JSON.stringify(dialect)}`);
  const names = options.names ?? "snake";
  if (names !== "snake" && names !== "preserve") throw bad(`names must be "snake" or "preserve", got ${JSON.stringify(names)}`);
  const ddl = options.ddl ?? true;
  const dropExisting = options.dropExisting ?? false;
  const transaction = options.transaction ?? true;
  const prefix = options.tablePrefix ?? "";
  const rename = names === "snake" ? snake : (s) => s;
  const cfg = source?.config ?? { query: source, options: {}, world: undefined };
  const plan = planStream(cfg.query, { ...cfg.options, ...streamOptions(options) }, cfg.world, { normalize: true });
  const pg = dialect === "postgres";

  const shape = shapeOfDocument(plan.inferred.document, plan.inferred.model, plan.inferred.rootType ?? "Query");
  if (shape === null) throw bad("toSQL does not support a Relay connection as the root collection: use a plain list");
  const tables = planTables(plan, shape);
  const poolSize = plan.runOptions.poolSize ?? POOL_SIZE;

  // names and columns
  const used = new Set();
  const colsOf = new Map();
  for (const t of tables.values()) {
    t.table = prefix + (options.tableNames?.[t.type] ?? rename(t.type));
    if (used.has(t.table)) throw bad(`two entity types map to the table ${JSON.stringify(t.table)}`, { hint: "set tableNames or names: \"preserve\"" });
    used.add(t.table);
    const hasIdKey = t.scalars.get("id")?.gen === "id.key";
    t.int = !t.text;
    t.pk = t.int && hasIdKey ? "id" : "_key";
    t.pkType = t.int ? "INTEGER" : "TEXT";
  }
  // child tables of owned lists get one foreign key per owner
  const ownerLists = new Map();
  for (const t of tables.values()) for (const l of t.lists.values()) {
    const arr = ownerLists.get(l.target) ?? [];
    arr.push({ owner: t, list: l });
    ownerLists.set(l.target, arr);
  }
  for (const t of tables.values()) {
    /** @type {any[]} */
    const cols = [{ name: t.pk, type: t.pkType, kind: t.int ? "int" : "text", pk: true }];
    for (const s of t.scalars.values()) {
      if (s.name === t.pk) continue;
      cols.push({ name: rename(s.name), type: sqlType(dialect, s.sdl, s.list), kind: kindOf(s.sdl, s.list), scalar: s });
    }
    for (const s of t.singles.values()) {
      const target = tables.get(s.target);
      cols.push({ name: `${rename(s.name)}_id`, type: target.pkType, kind: target.int ? "int" : "text", fk: target, single: s });
    }
    const owners = ownerLists.get(t.type) ?? [];
    for (const { owner, list } of owners) {
      const col = owners.length === 1 ? `${rename(owner.type)}_id` : `${rename(owner.type)}_${rename(list.name)}_id`;
      cols.push({ name: col, type: owner.pkType, kind: owner.int ? "int" : "text", fk: owner, owner: { type: owner.type, list: list.name } });
    }
    const seen = new Set();
    for (const c of cols) {
      if (seen.has(c.name)) throw bad(`table ${JSON.stringify(t.table)} would have two columns named ${JSON.stringify(c.name)}`, { hint: "rename a field with an alias or set names: \"preserve\"" });
      seen.add(c.name);
    }
    colsOf.set(t.type, cols);
    t.cols = cols;
  }

  const q = quoteIdent;
  const insertPrefix = new Map();
  for (const t of tables.values()) insertPrefix.set(t.type, `INSERT INTO ${q(t.table)} (${t.cols.map((c) => q(c.name)).join(", ")}) VALUES (`);

  const fkClause = (c) => `REFERENCES ${q(c.fk.table)} (${q(c.fk.pk)}) DEFERRABLE INITIALLY DEFERRED`;

  function header() {
    const out = [`-- graceholder: ${dialect} seed data, generated deterministically\n`];
    if (transaction) out.push("BEGIN;\n");
    if (ddl) {
      if (dropExisting) for (const t of [...tables.values()].reverse()) out.push(`DROP TABLE IF EXISTS ${q(t.table)}${pg ? " CASCADE" : ""};\n`);
      for (const t of tables.values()) {
        const lines = t.cols.map((c) => {
          const base = `${q(c.name)} ${c.type}${c.pk ? " PRIMARY KEY" : ""}`;
          return !pg && c.fk ? `${base} ${fkClause(c)}` : base;
        });
        out.push(`CREATE TABLE ${q(t.table)} (\n  ${lines.join(",\n  ")}\n);\n`);
      }
      if (pg) {
        for (const t of tables.values()) for (const c of t.cols) {
          if (c.fk) out.push(`ALTER TABLE ${q(t.table)} ADD CONSTRAINT ${q(`${t.table}_${c.name}_fkey`)} FOREIGN KEY (${q(c.name)}) ${fkClause(c)};\n`);
        }
      }
    }
    return out.join("");
  }

  function footer() {
    return transaction ? "COMMIT;\n" : "";
  }

  // ---- rows
  const seen = new Map();
  let pos = plan.offset;
  const end = plan.count === undefined ? Infinity : plan.offset + plan.count;
  let finished = false;

  const keyLiteral = (t, key) => {
    if (t.int) {
      if (!NUMERIC.test(key)) throw new GraceholderError("internal", `entity key ${JSON.stringify(key)} of ${t.type} is not numeric but its primary key is an integer`);
      return key;
    }
    return quoteText(key);
  };

  /**
   * Write the rows of one entity and everything below it.
   *
   * An entity of a shared type can be met in several places with different selections (as a root
   * item, as `post.author`, ...), and what hangs below it can differ per place. Its row is written
   * once, the first time. Each later meeting completes what the earlier ones left out: singular
   * references the row was written without (an UPDATE of the foreign key), and, because every owned
   * descendant is tracked too, child rows and their own references that are not written yet.
   *
   * `seen` has one entry per tracked entity: shared entities with a pool key (at most `poolSize` per
   * type) and everything they own, which is a function of those keys and not of the stream length, so
   * memory stays bounded. Owned entities of untracked entities (rows of a long root collection) are
   * unique by their path and are not remembered.
   *
   * @param {boolean} shared the place is a shared-pool reference (or a root item)
   * @param {boolean} tracked the entity is owned by a tracked entity
   */
  function walk(node, obj, path, trace, shared, tracked, links, out, emit) {
    const ref = trace.get(path);
    if (!ref) throw new GraceholderError("internal", `no entity recorded at ${path}`);
    const t = tables.get(ref.typeName);
    const key = String(ref.entityKey);
    /** @type {Set<string>|null} singular fields already written for this entity (null: not tracked) */
    let done = null;
    let known = false;
    let stored = false;
    if (tracked || (t.dedupe && shared)) {
      const id = `${t.type}\u0000${key}`;
      done = seen.get(id) ?? null;
      known = done !== null;
      if (!known) {
        done = new Set();
        if (tracked || !NUMERIC.test(key) || Number(key) <= poolSize) seen.set(id, done);
      }
      stored = seen.has(id);
    }
    const walkSingle = (single, child) =>
      walk(node.fields.get(single.key).node, child, `${path}/${single.key}`, trace, !single.owned, stored && single.owned, null, out, emit);

    if (!known) {
      const values = [];
      for (const c of t.cols) {
        if (c.pk) values.push(keyLiteral(t, key));
        else if (c.scalar) values.push(literal(dialect, c.kind, obj[c.scalar.key]));
        else if (c.single) {
          const child = obj[c.single.key];
          if (child !== undefined) done?.add(c.single.name);
          if (child === null || child === undefined) values.push("NULL");
          else values.push(keyLiteral(c.fk, walkSingle(c.single, child)));
        } else if (c.owner) {
          const link = links?.get(`${c.owner.type}\u0000${c.owner.list}`);
          values.push(link === undefined ? "NULL" : keyLiteral(c.fk, link));
        }
      }
      if (emit) out.push(`${insertPrefix.get(t.type)}${values.join(", ")});\n`);
    } else {
      for (const c of t.cols) {
        if (!c.single) continue;
        const child = obj[c.single.key];
        if (child === undefined || child === null) continue;
        const childKey = walkSingle(c.single, child); // writes what the child still lacks
        if (done && !done.has(c.single.name)) {
          done.add(c.single.name);
          if (emit) out.push(`UPDATE ${q(t.table)} SET ${q(c.name)} = ${keyLiteral(c.fk, childKey)} WHERE ${q(t.pk)} = ${keyLiteral(t, key)};\n`);
        }
      }
    }
    for (const l of t.lists.values()) {
      const arr = obj[l.key];
      if (!Array.isArray(arr)) continue;
      const entry = node.fields.get(l.key);
      const link = new Map([[`${t.type}\u0000${l.name}`, key]]);
      arr.forEach((el, i) => {
        if (el !== null && el !== undefined) walk(entry.node, el, `${path}/${l.key}/${i}`, trace, l.shared, stored && !l.shared, link, out, emit);
      });
    }
    return key;
  }

  /** Statements for the items `[from, to)` (absolute indexes). Must be consumed in order; earlier items are replayed silently. */
  function* rows(from = pos, to = end) {
    if (from < pos) throw bad(`rows must be requested in order: the writer is at item ${pos}, asked for ${from}`);
    if (finished) return;
    const stop = Math.min(to, end);
    while (pos < stop && !finished) {
      const emit = pos >= from;
      const target = emit ? stop : Math.min(from, stop);
      const size = Math.min(plan.chunkSize, target - pos);
      const trace = new Map();
      const items = plan.fetchWindow(pos, size, (path, value) => {
        const base = pathString(path);
        if (Array.isArray(value)) value.forEach((v, i) => v !== null && typeof v === "object" && v.typeName && trace.set(`${base}/${i}`, v));
        else if (value.typeName) trace.set(base, value);
      });
      const out = [];
      items.forEach((item, i) => {
        walk(shape, item, `${plan.key}/${i}`, trace, true, false, null, out, emit);
      });
      pos += items.length;
      if (items.length < size) finished = true;
      if (out.length) yield out.join("");
    }
  }

  const describe = () =>
    [...tables.values()].map((t) => ({ type: t.type, table: t.table, primaryKey: t.pk, columns: t.cols.map((c) => ({ name: c.name, type: c.type, references: c.fk ? c.fk.table : undefined })) }));

  return { dialect, header, rows, footer, tables: describe };
}

/** The stream-level options inside a toSQL options object. */
function streamOptions(options) {
  const out = {};
  for (const k of ["count", "offset", "chunkSize", "field", "seed", "spec", "packs", "images", "distributions", "schema", "variables", "operationName", "locale", "anchorDate", "strict"]) {
    if (options[k] !== undefined) out[k] = options[k];
  }
  return out;
}

/**
 * SQL for the root collection of a query and everything below it: DDL, INSERTs, COMMIT.
 * @param {any} source a query, or a `stream()` (including `world.stream()`)
 * @param {any} [options] stream options plus `dialect`, `ddl`, `dropExisting`, `transaction`, `names`, `tablePrefix`, `tableNames`, `header`, `footer`
 * @returns {Generator<string>} statements, each ending in a newline
 */
export function toSQL(source, options = {}) {
  const w = sqlWriter(source, options);
  return (function* () {
    if (options.header !== false) {
      const h = w.header();
      if (h) yield h;
    }
    yield* w.rows();
    if (options.footer !== false) {
      const f = w.footer();
      if (f) yield f;
    }
  })();
}
