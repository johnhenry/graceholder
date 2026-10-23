/** Error codes are part of the public API (docs/design.md section 9). */
export class GraceholderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ path?: string, hint?: string, cause?: unknown, errors?: readonly any[] }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "GraceholderError";
    this.code = code;
    if (extra.path !== undefined) this.path = extra.path;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.errors !== undefined) this.errors = extra.errors;
  }
}
