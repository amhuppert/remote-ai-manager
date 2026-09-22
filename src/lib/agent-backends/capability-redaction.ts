const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const LONG_OPAQUE_VALUE = /\b[A-Za-z0-9_-]{32,}\b/g;
const POSIX_HOME_PATH = /\/(?:Users|home)\/[^\s/]+/g;

export function redactAgentCapabilityText(raw: string): string {
  return raw
    .replace(SECRET_ASSIGNMENT, "$1=<redacted>")
    .replace(LONG_OPAQUE_VALUE, "<redacted>")
    .replace(POSIX_HOME_PATH, "~");
}
