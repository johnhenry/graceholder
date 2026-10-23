// Opaque, stable cursors: base64url("gc1:" + index), unpadded (docs/design.md 3.4). FROZEN at 1.0.0.
import { GraceholderError } from "./errors.js";

const PREFIX = "gc1:";

export function encodeCursor(index) {
  return btoa(PREFIX + index).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @returns {number} the non-negative integer index inside the cursor */
export function decodeCursor(cursor) {
  const bad = () => new GraceholderError("bad-cursor", `invalid cursor ${JSON.stringify(cursor)}`, { hint: "use a cursor returned by graceholder" });
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let text;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    text = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw bad();
  }
  if (!text.startsWith(PREFIX) || !/^[0-9]+$/.test(text.slice(PREFIX.length))) throw bad();
  const n = Number(text.slice(PREFIX.length));
  if (!Number.isSafeInteger(n)) throw bad();
  return n;
}
