/**
 * Which inherited environment variables never reach a Cursor worker
 * (spec R6.2).
 *
 * A worker is spawned from the Command Center server's own environment, and it
 * runs a model with unsandboxed shell and MCP tools — every one of which
 * inherits that environment in turn. Withholding `CURSOR_API_KEY` alone would
 * hand the server's other credentials to the model and to anything it chooses
 * to run, so the whole credential-shaped surface is dropped at the spawn
 * boundary instead.
 *
 * This module is the single owner of that rule because two consumers depend on
 * agreeing about it: the supervisor strips exactly what the authenticated
 * acceptance suite scans process boundaries for. Were the suite to hold its own
 * narrower definition, it could report a worker environment clean on variables
 * production never removed.
 *
 * Command Center's own contract variables are NOT the concern here. They are
 * re-supplied by `buildSessionEnvContract` after this filter runs — deliberately
 * placed rather than inherited — which is what keeps `cctl` working inside a
 * Cursor session while the ambient copy of the same variable is dropped.
 */

/**
 * `KEY` is matched only as a whole underscore-delimited segment: `KEYBOARD_…`
 * and `MONKEY_…` are not credentials, and a filter that silently ate them would
 * be discovered as a broken agent rather than as a policy. The other words are
 * matched anywhere, because `PGPASSWORD` and its kind run them together.
 */
const CREDENTIAL_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /(?:^|_)(?:API_?)?KEYS?(?:$|_)/,
  /TOKEN/,
  /SECRET/,
  /PASSWORD/,
  /PASSWD/,
  /CREDENTIAL/,
];

/** Whether a variable's NAME advertises that its value is a credential. */
export function isCredentialShapedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return CREDENTIAL_ENV_KEY_PATTERNS.some((pattern) => pattern.test(upper));
}

/** The credential-shaped names present in `env`. Names only — a name is safe to
 *  log and a value never is. */
export function ambientCredentialKeys(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(env).filter(isCredentialShapedEnvKey);
}

/**
 * `env` without its credential-shaped variables.
 *
 * A key is dropped on its NAME, whatever its value: an empty or undefined
 * credential variable still tells the child that the name is live, and keeping
 * it would make the filter depend on whether the operator happened to export a
 * value this time.
 */
export function withoutAmbientCredentials(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isCredentialShapedEnvKey(key)) continue;
    filtered[key] = value;
  }
  return filtered;
}
