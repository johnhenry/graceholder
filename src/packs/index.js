// All packs. Import this entry to get every pack; import `@johnhenry/graceholder/packs/<name>` to ship one.
import { geo } from "./geo.js";
import { commerce } from "./commerce.js";
import { finance } from "./finance.js";
import { health } from "./health.js";

export { geo, commerce, finance, health };
/** Every pack, in registration order. */
export const allPacks = Object.freeze([geo, commerce, finance, health]);
