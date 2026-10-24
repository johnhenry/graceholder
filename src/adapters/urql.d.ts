import type { Exchange } from "@urql/core";
import type { AdapterOptions } from "./shared.js";

export type GraceholderExchangeOptions = AdapterOptions;

/** An exchange that answers queries and mutations from a graceholder world; it replaces `fetchExchange`. */
export declare function graceholderExchange(options?: GraceholderExchangeOptions): Exchange;
export default graceholderExchange;
