import type { DocumentNode, GraphQLError } from "graphql";

/** Key-scheme version literal (frozen at 1.0.0). */
export declare const KEY_SCHEME: "gh1";

export interface Options {
  /** Default `"graceholder"`. Numbers are stringified (`String(n)`). */
  seed?: string | number;
  /** Variables for the operation. */
  variables?: Record<string, unknown>;
  operationName?: string;
  /** Default `"en"`, the only locale in this release; others throw `unknown-locale`. */
  locale?: string;
  /** Default constant `"2025-01-01T00:00:00.000Z"`; the clock is never read. */
  anchorDate?: string | Date;
  /** `"throw"` (default) throws a {@link GraceholderError}; `"result"` returns `{ data, errors }`. */
  errors?: "throw" | "result";
  /** Side-car spec keyed by path pattern (`users.name`, `*.status`, `**.createdAt`, `@User.email`). */
  spec?: Spec;
  /** Make a spec path that matches no field an error (`unused-spec-path`) instead of a reported decision. */
  strict?: boolean;
}

export type Count = number | [number, number] | { min: number; max: number };

export interface FieldSpec {
  list?: boolean;
  one?: boolean;
  count?: Count;
  gen?: string | { name: string; args?: Record<string, unknown> };
  pattern?: string;
  pick?: Array<unknown | { value: unknown; weight: number }>;
  nullRate?: number;
  derive?: { from: string };
  type?: string;
  seed?: string | number;
  /** Identifying argument name(s); several names form a composite key. */
  key?: string | string[];
  /** Draw members of a nested collection from the type pool. */
  shared?: boolean;
  /** Do not share the type pool: entities are owned by their parent. */
  own?: boolean;
}

export type MutationOp = "create" | "update" | "delete";

/** How mutations are read (docs/design.md section 16, World); used by a world only. */
export interface MutationSpec {
  /** Extra verbs: the first word of a mutation field name. */
  verbs?: Record<string, MutationOp>;
  /** Per mutation field: what it does, which type it affects, where its id and input are. */
  fields?: Record<string, { op: MutationOp; type?: string; idArg?: string; input?: string; read?: string }>;
  /** `"Post.authorId": "User"` makes a created Post belong to that User's `posts`-like collections. */
  relations?: Record<string, string>;
  /** Where created entities go: the end of finite collections and the start of endless ones by default. */
  position?: "start" | "end";
}

export type Spec = { [path: string]: FieldSpec | { poolSize?: number; endlessTotal?: number } | MutationSpec } & {
  $options?: { poolSize?: number; endlessTotal?: number };
  $mutations?: MutationSpec;
};

export type Data = Record<string, unknown>;

export interface ResultMode {
  data?: Data;
  errors?: readonly GraphQLError[];
}

/** Generate data for a query. Synchronous; same inputs give byte-identical output. */
export declare function graceholder(query: string | DocumentNode, options?: Options & { errors?: "throw" }): Data;
export declare function graceholder(query: string | DocumentNode, options: Options & { errors: "result" }): ResultMode;
export declare function graceholder(query: string | DocumentNode, options: Options): Data | ResultMode;

export interface Decision {
  path: string;
  field: string;
  kind: "list" | "object" | "scalar" | "arg" | "type" | "count" | "null" | "key" | "seed" | "unused";
  value: unknown;
  source: "directive" | "spec" | "heuristic" | "default";
  rule?: string;
}

export interface InferResult {
  sdl: string;
  decisions: Decision[];
  /** The selected operation and the fragments it uses. */
  document: DocumentNode;
}

/** Infer the SDL (and the decisions behind it) from a query alone. */
export declare function inferSchema(
  query: string | DocumentNode,
  spec?: Spec,
  options?: Pick<Options, "operationName" | "variables" | "strict">,
): InferResult;

export type ErrorCode =
  | "unknown-directive"
  | "unknown-generator"
  | "bad-generator-args"
  | "conflicting-shape"
  | "bad-operation"
  | "bad-options"
  | "bad-cursor"
  | "bad-arguments"
  | "unknown-locale"
  | "bad-spec"
  | "bad-directive"
  | "bad-derive"
  | "conflicting-overrides"
  | "unused-spec-path"
  | "bad-suggestion"
  | "unsupported"
  | "bad-mutation"
  | "not-found"
  | "graphql"
  | "internal";

export declare class GraceholderError extends Error {
  code: ErrorCode;
  path?: string;
  hint?: string;
  /** For `graphql` errors, every underlying GraphQL error. */
  errors?: readonly GraphQLError[];
  constructor(code: ErrorCode, message: string, extra?: { path?: string; hint?: string; cause?: unknown });
}

/** Version tag at the top of the suggestSpec prompt. */
export declare const SUGGEST_PROMPT_VERSION: string;

/** The prompt `suggestSpec` sends (query, inferred SDL and decisions, spec grammar, generator names). */
export declare function buildSuggestPrompt(query: string, spec?: Spec): string;

/**
 * Authoring-time helper: ask an injected model for a spec, validate it against the query, and offer
 * one repair round. The core never calls it and imports no LLM SDK.
 * @throws {GraceholderError} `bad-suggestion` when the reply is still invalid after the repair round
 */
export declare function suggestSpec(
  query: string,
  opts: { llm: (prompt: string) => Promise<string>; spec?: Spec },
): Promise<Spec>;

export type WorldEntry =
  | { op: "pin"; type: string; key: string; fields: Record<string, unknown> }
  | { op: "create"; type: string; key: string; fields: Record<string, unknown>; rel?: Array<{ ownerType: string; ownerKey: string }>; mutation?: string }
  | { op: "update"; type: string; key: string; fields: Record<string, unknown>; rel?: Array<{ ownerType: string; ownerKey: string }>; mutation?: string }
  | { op: "delete"; type: string; key: string; mutation?: string };

export interface ExportedWorld {
  seed: string | number;
  spec?: Spec;
  anchorDate: string;
  locale: string;
  log: WorldEntry[];
}

export interface WorldOptions {
  seed?: string | number;
  spec?: Spec;
  anchorDate?: string | Date;
  locale?: string;
  strict?: boolean;
  /** A log from `world.export()`; replayed at creation. */
  log?: WorldEntry[];
}

export interface WorldResult {
  data?: Data | null;
  errors?: Array<{ message: string; locations?: Array<{ line: number; column: number }>; path?: Array<string | number>; extensions?: Record<string, unknown> }>;
}

export interface World {
  /** Run a query or a mutation. Never throws for a bad operation: failures come back as `errors`. */
  query(query: string | DocumentNode, options?: { variables?: Record<string, unknown>; operationName?: string }): WorldResult;
  /** Override fields of the entity `"Type:key"`. */
  pin(ref: string, fields: Record<string, unknown>): World;
  export(): ExportedWorld;
  reset(): World;
}

/** A persistent, deterministic world shared across queries. */
export declare function createWorld(options?: WorldOptions): World;
