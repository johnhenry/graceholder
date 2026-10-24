import type { World } from "../index.js";
import type { AdapterOptions } from "./shared.js";

export interface CreateFetchOptions extends AdapterOptions {
  /** Which requests the world answers. Default: URL paths ending in `/graphql`. A string is an exact path or URL. */
  match?: string | RegExp | ((url: URL, request: { method: string }) => boolean);
  /** Where non-matching requests go. Default `globalThis.fetch`. */
  fallback?: typeof fetch;
}

export type GraceholderFetch = typeof fetch & { readonly world: World };

/** A fetch-compatible function: GraphQL requests are answered by a world, everything else passes through. */
export declare function createFetch(options?: CreateFetchOptions): GraceholderFetch;
export default createFetch;
