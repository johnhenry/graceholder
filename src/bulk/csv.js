// CSV (RFC 4180) with flattened column paths. See docs/api.md "toCSV".
import { GraceholderError } from "../errors.js";
import { isAsync, isSync } from "./source.js";
import { shapeOfDocument, shapeOfValue } from "./shape.js";

const bad = (msg) => new GraceholderError("bad-options", msg);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The ordered column paths of a shape (`address.city`, `tags`, `posts` for a JSON-encoded list).
 * @param {import("./shape.js").ShapeNode} node
 * @param {{ explode: (path: string) => boolean, prefix?: string }} options
 * @returns {string[]}
 */
export function columnsOf(node, { explode, prefix = "" }) {
  const out = [];
  for (const f of node.fields.values()) {
    const path = prefix + f.key;
    const exploded = f.list && explode(path);
    if (f.kind === "object" && (!f.list || exploded)) out.push(...columnsOf(/** @type {any} */ (f.node), { explode, prefix: `${path}.` }));
    else out.push(path);
  }
  return out;
}

/** Rows (maps of column path to value) for one item; a non-exploded item is exactly one row. */
function rowsOf(node, obj, explode, prefix) {
  /** @type {Map<string, any>[]} */
  let rows = [new Map()];
  const cross = (subRows) => (rows = rows.flatMap((r) => subRows.map((s) => new Map([...r, ...s]))));
  for (const f of node.fields.values()) {
    const path = prefix + f.key;
    const v = obj == null ? null : obj[f.key];
    const exploded = f.list && explode(path);
    if (f.kind === "object" && (!f.list || exploded)) {
      const blank = () => new Map(columnsOf(f.node, { explode, prefix: `${path}.` }).map((c) => [c, null]));
      if (!f.list) {
        cross(isObject(v) ? rowsOf(f.node, v, explode, `${path}.`) : [blank()]);
      } else {
        const subs = Array.isArray(v) ? v.flatMap((e) => rowsOf(f.node, e, explode, `${path}.`)) : [];
        cross(subs.length ? subs : [blank()]);
      }
    } else if (f.list && exploded) {
      const values = Array.isArray(v) && v.length ? v : [null];
      cross(values.map((e) => new Map([[path, e]])));
    } else {
      cross([new Map([[path, v === undefined ? null : v]])]);
    }
  }
  return rows;
}

function cell(value, delimiter) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text === "") return '""'; // an empty string is not a null
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {any} source items, for example a `stream()` (an iterable or an async iterable)
 * @param {{ delimiter?: string, eol?: string, header?: boolean, columns?: string[], lists?: "json"|"explode", explode?: string[] }} [options]
 * @returns {Generator<string>|AsyncGenerator<string>} the header line, then one or more lines per item
 */
export function toCSV(source, options = {}) {
  const delimiter = options.delimiter ?? ",";
  const eol = options.eol ?? "\r\n";
  const header = options.header ?? true;
  if (typeof delimiter !== "string" || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw bad(`delimiter must be one character other than a quote or a line break, got ${JSON.stringify(delimiter)}`);
  if (typeof eol !== "string" || !/^(\r\n|\n|\r)$/.test(eol)) throw bad('eol must be "\\r\\n", "\\n" or "\\r"');
  const lists = options.lists ?? "json";
  if (lists !== "json" && lists !== "explode") throw bad(`lists must be "json" or "explode", got ${JSON.stringify(lists)}`);
  if (options.columns !== undefined && (!Array.isArray(options.columns) || !options.columns.every((c) => typeof c === "string"))) throw bad("columns must be an array of column paths");
  if (options.explode !== undefined && (!Array.isArray(options.explode) || !options.explode.every((c) => typeof c === "string"))) throw bad("explode must be an array of list paths");
  if (!isSync(source) && !isAsync(source)) throw bad("the source must be an iterable or an async iterable of items, for example a stream()");
  // `explode` names the lists to explode; `lists: "explode"` alone explodes every list
  const wanted = options.explode ? new Set(options.explode) : null;
  const explode = wanted ? (path) => wanted.has(path) : lists === "explode" ? () => true : () => false;

  // a stream knows its shape; any other source is sampled from its first item
  /** @type {any} */
  let shape = source?.plan ? shapeOfDocument(source.plan.inferred.document, source.plan.inferred.model, source.plan.inferred.rootType ?? "Query") : null;
  /** @type {string[]} */
  // @ts-ignore assigned by begin() before any row is written
  let columns = options.columns;
  const line = (cells) => `${cells.map((c) => cell(c, delimiter)).join(delimiter)}${eol}`;
  const begin = (sample) => {
    shape ??= shapeOfValue(sample);
    columns ??= columnsOf(/** @type {any} */ (shape), { explode });
    return header ? [line(columns)] : [];
  };
  const rowLines = (item) => {
    const obj = isObject(item) ? item : { value: item };
    return rowsOf(shape, obj, explode, "").map((r) => line(columns.map((c) => r.get(c) ?? null)));
  };
  let started = false;
  const step = (item) => {
    const out = [];
    if (!started) {
      started = true;
      out.push(...begin(isObject(item) ? item : { value: item }));
    }
    out.push(...rowLines(item));
    return out;
  };
  const finish = () => (started ? [] : begin({}));

  if (isSync(source)) {
    return (function* () {
      for (const item of source) yield* step(item);
      yield* finish();
    })();
  }
  return (async function* () {
    for await (const item of source) yield* step(item);
    yield* finish();
  })();
}
