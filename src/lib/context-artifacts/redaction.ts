/**
 * Pure, deterministic, pattern-based redaction (design §7.5). Applied to the
 * rendered transcript before it becomes model input, and to the generated
 * envelope before persistence (defense in depth). False positives are
 * acceptable; leaked secrets are not.
 */

const PEM_BLOCK =
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

const GITHUB_TOKEN =
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;

const AI_STYLE_API_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;

const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;

const BEARER_TOKEN =
  /\bBearer\s+(?=[A-Za-z0-9\-._~+/]*[0-9.\-_~+/])[A-Za-z0-9\-._~+/]{8,}=*/g;

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

// password/token/secret/api_key assignments (`=` or `:`) with a non-trivial
// value. The optional closing quote before the separator covers quoted keys
// in JSON/YAML/Python-dict material (`{"password": "…"}`).
const CREDENTIAL_ASSIGNMENT =
  /\b(?<key>[A-Za-z0-9_]*(?:password|passwd|token|secret|api[_-]?key)[A-Za-z0-9_]*)(?<sep>["']?\s*[:=]\s*)(?:"(?<dq>[^"\n]+)"|'(?<sq>[^'\n]+)'|(?<bare>[A-Za-z0-9+/_.-]+))/gi;

// Generic 32+ char hex/base64 value assigned to a *Key/*Token/*Secret variable
// (e.g. `signingKey = ...`), independent of the credential-name vocabulary above.
const GENERIC_SECRET_ASSIGNMENT =
  /\b(?<key>[A-Za-z][A-Za-z0-9]*(?:_key|_token|_secret|Key|Token|Secret))(?<sep>["']?\s*[:=]\s*)(?:"(?<dq>[A-Za-z0-9+/=]{32,})"|'(?<sq>[A-Za-z0-9+/=]{32,})'|(?<bare>[A-Za-z0-9+/=]{32,}))\b/g;

const TRIVIAL_VALUE_MIN_LENGTH = 8;

const TRIVIAL_VALUES = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "n/a",
  "todo",
  "changeme",
  "change_me",
  "xxx",
  "placeholder",
  "example",
  "redacted",
]);

const PURE_ALPHA_VALUE = /^[A-Za-z_]+$/;

function isTrivialCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < TRIVIAL_VALUE_MIN_LENGTH) return true;
  if (TRIVIAL_VALUES.has(trimmed.toLowerCase())) return true;
  // A value with no digits and no symbols reads as a plain word or code
  // identifier (e.g. `computeSecretSauce`) rather than a credential.
  if (PURE_ALPHA_VALUE.test(trimmed)) return true;
  return false;
}

interface CredentialMatchGroups {
  key: string;
  sep: string;
  dq?: string;
  sq?: string;
  bare?: string;
}

function isCredentialMatchGroups(
  value: unknown,
): value is CredentialMatchGroups {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.sep === "string";
}

function redactCredentialAssignment(
  text: string,
  pattern: RegExp,
  className: string,
): string {
  return text.replace(pattern, (match: string, ...args: unknown[]): string => {
    const groups = args[args.length - 1];
    if (!isCredentialMatchGroups(groups)) return match;
    const value = groups.dq ?? groups.sq ?? groups.bare;
    if (value === undefined || isTrivialCredentialValue(value)) return match;
    return `${groups.key}${groups.sep}[REDACTED:${className}]`;
  });
}

export function redactText(text: string): string {
  let result = text;
  result = result.replace(PEM_BLOCK, "[REDACTED:pem-key]");
  result = result.replace(AWS_KEY, "[REDACTED:aws-key]");
  result = result.replace(GITHUB_TOKEN, "[REDACTED:github-token]");
  result = result.replace(AI_STYLE_API_KEY, "[REDACTED:api-key]");
  result = result.replace(SLACK_TOKEN, "[REDACTED:slack-token]");
  result = result.replace(BEARER_TOKEN, "Bearer [REDACTED:bearer-token]");
  result = result.replace(JWT, "[REDACTED:jwt]");
  result = redactCredentialAssignment(
    result,
    CREDENTIAL_ASSIGNMENT,
    "credential",
  );
  result = redactCredentialAssignment(
    result,
    GENERIC_SECRET_ASSIGNMENT,
    "generic-secret",
  );
  return result;
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      result[key] = redactJsonValue(entryValue);
    }
    return result;
  }
  return value;
}

/**
 * Deep-walks any JSON-ish value (objects, arrays, primitives), redacting every
 * string leaf. The cast back to `T` is unavoidable for a generic recursive
 * transform: TypeScript cannot express "same shape as T, strings redacted" as
 * a derived type, but the runtime walk above preserves the input's exact
 * structure (only string leaves change), so the shape guarantee holds.
 */
export function redactEnvelopeStrings<T>(value: T): T {
  return redactJsonValue(value) as T;
}
