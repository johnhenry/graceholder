// Name tokenising, singularising and type-name derivation (docs/design.md 4.2). FROZEN at 1.0.0.

/** Split a field or type name into lowercase words. */
export function tokenize(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const IRREGULAR = new Map([
  ["people", "person"], ["men", "man"], ["women", "woman"], ["children", "child"], ["mice", "mouse"],
  ["feet", "foot"], ["teeth", "tooth"], ["geese", "goose"], ["analyses", "analysis"], ["indices", "index"],
  ["criteria", "criterion"], ["knives", "knife"], ["wives", "wife"], ["leaves", "leaf"], ["lives", "life"],
  ["shelves", "shelf"], ["wolves", "wolf"], ["data", "data"],
  // -ie words that the generic ies->y rule would turn into -y
  ["movies", "movie"], ["cookies", "cookie"], ["pies", "pie"], ["ties", "tie"], ["lies", "lie"],
  ["zombies", "zombie"], ["selfies", "selfie"], ["rookies", "rookie"], ["calories", "calorie"],
  ["species", "species"], ["series", "series"],
]);

/** Singularise one lowercase word. Rules in order, first match wins. */
export function singularize(word) {
  const irregular = IRREGULAR.get(word);
  if (irregular !== undefined) return irregular;
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export const pascal = (tokens) => tokens.map((t) => t[0].toUpperCase() + t.slice(1)).join("");

/** Names a derived object type may not take (N5). */
const RESERVED = new Set(["Int", "Float", "String", "Boolean", "ID", "DateTime", "Query", "Mutation", "Subscription"]);

/** N3 + N5: singularise the last word of the field name, PascalCase, avoid collisions. */
export function typeNameFor(fieldName) {
  const tokens = tokenize(fieldName);
  if (tokens.length === 0) return "Object";
  tokens[tokens.length - 1] = singularize(tokens[tokens.length - 1]);
  let name = pascal(tokens);
  if (/^[0-9]/.test(name)) name = "T" + name;
  return RESERVED.has(name) ? name + "Type" : name;
}

const KINDS = [
  ["person", ["user", "person", "customer", "author", "member", "employee", "contact", "account", "profile", "owner", "student", "patient", "driver", "guest", "reviewer", "commenter", "friend", "follower", "manager", "admin"]],
  ["org", ["company", "organization", "org", "team", "brand", "vendor", "store", "shop", "employer"]],
  ["product", ["product", "item", "sku", "listing"]],
  ["post", ["post", "article", "comment", "message", "review", "note", "story"]],
  ["order", ["order", "invoice", "cart", "payment", "receipt"]],
];

/** Persona kind of a type name (docs/design.md 6.1): first kind with a matching token wins. */
export function personaKind(typeName) {
  const tokens = tokenize(typeName);
  for (const [kind, words] of KINDS) if (tokens.some((t) => words.includes(t))) return kind;
  return "generic";
}

const PLURALS = new Map([["person", "people"], ["man", "men"], ["woman", "women"], ["child", "children"], ["mouse", "mice"], ["foot", "feet"], ["tooth", "teeth"], ["goose", "geese"]]);

/** Plural of one lowercase word (used to name a collection that is counted but not selected). */
export function pluralize(word) {
  const irregular = PLURALS.get(word);
  if (irregular) return irregular;
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  return word + "s";
}
