/**
 * Build a sanitized copy of process.env for child processes.
 *
 * CC itself runs as a production Next.js server, so its process.env contains
 * variables that confuse or break child processes:
 *
 * - `NODE_ENV=production` — causes test runners to load React's production
 *   build (where `act()` is unavailable) and dev servers to behave incorrectly
 * - `__NEXT_*` / `__TURBOPACK_*` — Next.js/Turbopack internal vars that crash
 *   child Next.js processes
 * - `NODE_CHANNEL_*` — Node IPC channel vars from the parent process
 *
 * By removing `NODE_ENV`, each child tool uses its own default:
 * Jest → "test", Next.js dev → "development", etc.
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete (env as Record<string, string | undefined>).NODE_ENV;

  for (const key of Object.keys(env)) {
    if (
      key.startsWith("__NEXT_") ||
      key.startsWith("NODE_CHANNEL_") ||
      key.startsWith("__TURBOPACK_")
    ) {
      delete env[key];
    }
  }

  return env;
}
