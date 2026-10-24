// Evaluates the type-level reader (src/typed.d.ts) through the TypeScript compiler API, so a test
// can compare the inferred type of a query with the data the library really produces.
import ts from "typescript";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPED = fileURLToPath(new URL("../src/typed.d.ts", import.meta.url));

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

/**
 * @param {string[]} snippets TypeScript type expressions, for example `ResultOf<"{ a }">` or `ItemOf<"{ a { id } }">`
 * @returns {{ program: import("typescript").Program, aliases: import("typescript").Type[], checker: import("typescript").TypeChecker, diagnostics: string[], ms: number }}
 */
export function compileTypes(snippets) {
  const source = `import type { ResultOf, ItemOf } from ${JSON.stringify(TYPED.replace(/\.d\.ts$/, ".js"))};\n` + snippets.map((s, i) => `export type T${i} = ${s};`).join("\n");
  const virtual = `${ROOT}__virtual_types__.ts`;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (name === virtual ? ts.createSourceFile(name, source, lang) : getSourceFile(name, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtual || fileExists(name);
  const started = performance.now();
  const program = ts.createProgram([virtual], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(virtual);
  const decls = sf.statements.filter((s) => ts.isTypeAliasDeclaration(s) && /^T\d+$/.test(s.name.text));
  const aliases = decls.map((d) => checker.getTypeFromTypeNode(d.type));
  // force evaluation of every alias, then collect the diagnostics of the virtual file
  const shapes = aliases.map((t) => describe(checker, t));
  const diagnostics = program.getSemanticDiagnostics(sf).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  return { program, aliases, shapes, checker, diagnostics, ms: performance.now() - started, instantiations: program.getInstantiationCount() };
}

/** A plain description of a type: strings, numbers, booleans, null, literals, arrays, objects, unions, unknown. */
export function describe(checker, type, depth = 0) {
  const F = ts.TypeFlags;
  if (depth > 40) return { kind: "deep" };
  if (type.flags & F.Any) return { kind: "any" };
  if (type.flags & F.Unknown) return { kind: "unknown" };
  if (type.flags & F.Never) return { kind: "never" };
  if (type.flags & F.Null) return { kind: "null" };
  if (type.flags & F.Undefined) return { kind: "undefined" };
  if (type.flags & F.StringLiteral) return { kind: "literal", value: type.value };
  if (type.flags & F.String) return { kind: "string" };
  if (type.flags & F.Number) return { kind: "number" };
  if (type.flags & F.NumberLiteral) return { kind: "number" };
  if (type.flags & F.Boolean || type.flags & F.BooleanLiteral) return { kind: "boolean" };
  if (type.isUnion()) {
    const members = [];
    for (const m of type.types) {
      const d = describe(checker, m, depth + 1);
      if (!members.some((x) => JSON.stringify(x) === JSON.stringify(d))) members.push(d);
    }
    const hasTrue = members.filter((m) => m.kind === "boolean");
    if (hasTrue.length > 1) return describe(checker, checker.getBooleanType(), depth);
    return members.length === 1 ? members[0] : { kind: "union", members };
  }
  if (checker.isArrayType(type)) return { kind: "array", element: describe(checker, checker.getTypeArguments(type)[0], depth + 1) };
  if (type.flags & F.Intersection) return { kind: "intersection" };
  if (type.flags & F.Object) {
    const props = {};
    for (const p of checker.getPropertiesOfType(type)) {
      const t = checker.getTypeOfSymbol(p);
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      props[p.name] = { type: describe(checker, optional ? checker.getNonNullableType(t) : t, depth + 1), optional };
    }
    return { kind: "object", props };
  }
  return { kind: "other", text: checker.typeToString(type) };
}

/** Does `value` (parsed JSON) fit the described type? Returns a list of problems (empty when it fits). */
export function fits(shape, value, path = "$", out = []) {
  const bad = (msg) => out.push(`${path}: ${msg}`);
  switch (shape.kind) {
    case "any":
    case "unknown": return out;
    case "never": bad("the type is never"); return out;
    case "null": if (value !== null) bad(`type is null, value is ${JSON.stringify(value)}`); return out;
    case "literal": if (value !== shape.value) bad(`type is ${JSON.stringify(shape.value)}, value is ${JSON.stringify(value)}`); return out;
    case "string": if (typeof value !== "string") bad(`type is string, value is ${JSON.stringify(value)}`); return out;
    case "number": if (typeof value !== "number") bad(`type is number, value is ${JSON.stringify(value)}`); return out;
    case "boolean": if (typeof value !== "boolean") bad(`type is boolean, value is ${JSON.stringify(value)}`); return out;
    case "array":
      if (!Array.isArray(value)) bad(`type is a list, value is ${JSON.stringify(value)?.slice(0, 40)}`);
      else value.forEach((v, i) => fits(shape.element, v, `${path}[${i}]`, out));
      return out;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        bad(`type is an object, value is ${JSON.stringify(value)?.slice(0, 40)}`);
        return out;
      }
      for (const [k, p] of Object.entries(shape.props)) {
        if (!(k in value)) {
          if (!p.optional) bad(`type has ${k}, value does not`);
          continue;
        }
        fits(p.type, value[k], `${path}.${k}`, out);
      }
      for (const k of Object.keys(value)) if (!(k in shape.props)) bad(`value has ${k}, type does not`);
      return out;
    }
    case "union": {
      const tries = shape.members.map((m) => fits(m, value, path, []));
      if (tries.some((t) => t.length === 0)) return out;
      bad(`no member of the union fits ${JSON.stringify(value)?.slice(0, 60)} (${tries.map((t) => t[0]).join(" | ")})`);
      return out;
    }
    default: bad(`cannot compare ${shape.kind} ${shape.text ?? ""}`); return out;
  }
}

/** Paths at which a described type is `unknown` or `any` (the places inference gave up). */
export function unknownPaths(shape, path = "$", out = []) {
  if (shape.kind === "unknown" || shape.kind === "any") out.push(path);
  else if (shape.kind === "array") unknownPaths(shape.element, `${path}[]`, out);
  else if (shape.kind === "object") for (const [k, p] of Object.entries(shape.props)) unknownPaths(p.type, `${path}.${k}`, out);
  else if (shape.kind === "union") shape.members.forEach((m) => unknownPaths(m, path, out));
  return out;
}
