export class MailError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MailError";
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error: unknown) {
  return error instanceof MailError
    ? { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }
    : { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } };
}

export function validName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new MailError("INVALID_NAME", "Use 1–64 letters, digits, underscores or hyphens; start with a letter or digit.");
  }
  return value;
}

export function validUuid(value: string, code = "INVALID_MESSAGE_ID"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new MailError(code, "Use the complete 36-character message UUID, including hyphens.");
  }
  return value;
}

export function validSession(value: string): string {
  if (typeof value !== "string" || !value || value.length > 256) throw new MailError("INVALID_SESSION","Session ID must contain 1–256 characters.");
  return value;
}

export function boundedInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MailError("INVALID_ARGUMENT", `${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
