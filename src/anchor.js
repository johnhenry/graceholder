// The constant default anchor and its parsing (docs/design.md 6.4). The clock is never read.
import { GraceholderError } from "./errors.js";

export const DEFAULT_ANCHOR = "2025-01-01T00:00:00.000Z";

/** @param {string|Date} anchorDate @returns {number} milliseconds since the epoch */
export function anchorMs(anchorDate) {
  const ms = anchorDate instanceof Date ? anchorDate.getTime() : typeof anchorDate === "string" ? Date.parse(anchorDate) : NaN;
  if (!Number.isFinite(ms)) {
    throw new GraceholderError("bad-options", `anchorDate must be an ISO date string or a Date, got ${String(anchorDate)}`);
  }
  return ms;
}
