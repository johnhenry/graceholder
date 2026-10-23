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
  /** Reserved: the side-car spec is not supported yet and throws `unsupported`. */
  spec?: never;
}

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
  kind: "list" | "object" | "scalar" | "arg" | "type" | "count";
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
  spec?: undefined,
  options?: Pick<Options, "operationName" | "variables">,
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
  | "unsupported"
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
