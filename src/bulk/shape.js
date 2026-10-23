// The static shape of a stream's items: which fields a root item has, by response key.
// Built from the inferred document and model, or from a sample value when there is no model.
import { Kind } from "graphql";

/**
 * @typedef {{ key: string, name: string, kind: "scalar"|"object", list: boolean, sdl?: string, gen?: string, typeName?: string, connection?: boolean, args?: boolean, node?: ShapeNode }} ShapeField
 * @typedef {{ typeName: string, fields: Map<string, ShapeField> }} ShapeNode
 */

/**
 * Shape of the items of the single root field of `document` (the document a plan executes).
 * @returns {ShapeNode|null} null for a connection root
 */
export function shapeOfDocument(document, model, rootType) {
  const fragments = new Map(document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  const collect = (selSet, typeName, node) => {
    for (const s of selSet.selections) {
      if (s.kind === Kind.INLINE_FRAGMENT) {
        collect(s.selectionSet, s.typeCondition?.name.value ?? typeName, node);
      } else if (s.kind === Kind.FRAGMENT_SPREAD) {
        const def = fragments.get(s.name.value);
        collect(def.selectionSet, def.typeCondition.name.value, node);
      } else if (s.kind === Kind.FIELD) {
        const name = s.name.value;
        if (name.startsWith("__")) continue;
        const f = model.get(typeName)?.get(name);
        if (!f) continue;
        const key = s.alias?.value ?? name;
        let entry = node.fields.get(key);
        if (!entry) {
          entry = {
            key, name, kind: f.kind === "object" ? "object" : "scalar", list: Boolean(f.list), sdl: f.sdl, gen: f.gen, typeName: f.typeName,
            connection: Boolean(f.connection), args: (s.arguments?.length ?? 0) > 0,
          };
          if (entry.kind === "object") entry.node = { typeName: f.typeName, fields: new Map() };
          node.fields.set(key, entry);
        }
        if (s.selectionSet && entry.node) collect(s.selectionSet, f.typeName, entry.node);
      }
    }
  };
  const field = document.definitions[0].selectionSet.selections[0];
  const root = model.get(rootType).get(field.name.value);
  /** @type {ShapeNode} */
  const node = { typeName: root.typeName, fields: new Map() };
  if (root.connection) return null; // a connection root streams its nodes: the caller samples the first item
  collect(field.selectionSet, root.typeName, node);
  return node;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Shape guessed from one sample item (first-seen keys; nulls are scalars). */
export function shapeOfValue(value) {
  /** @type {ShapeNode} */
  const node = { typeName: "", fields: new Map() };
  if (!isObject(value)) return node;
  for (const [key, v] of Object.entries(value)) {
    const first = Array.isArray(v) ? v.find((x) => x !== null && x !== undefined) : v;
    if (isObject(first)) {
      node.fields.set(key, { key, name: key, kind: "object", list: Array.isArray(v), node: shapeOfValue(first) });
    } else {
      node.fields.set(key, { key, name: key, kind: "scalar", list: Array.isArray(v) });
    }
  }
  return node;
}
