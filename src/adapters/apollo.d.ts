import { ApolloLink } from "@apollo/client";
import type { World } from "../index.js";
import type { AdapterOptions } from "./shared.js";

export type GraceholderLinkOptions = AdapterOptions;

/** A terminating Apollo link that answers every operation from a graceholder world. */
export declare class GraceholderLink extends ApolloLink {
  constructor(options?: GraceholderLinkOptions);
  /** The world that answers; use it to pin entities or export the log. */
  readonly world: World;
}
export default GraceholderLink;
