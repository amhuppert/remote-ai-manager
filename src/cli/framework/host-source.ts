import type { CliEnv, CliHost } from "../transport";

export type CcHostSource =
  | CliHost
  | ((env: CliEnv, signal: AbortSignal) => Promise<CliHost>);

export async function resolveCcHost(
  source: CcHostSource,
  env: CliEnv,
  signal: AbortSignal,
): Promise<CliHost> {
  return typeof source === "function" ? source(env, signal) : source;
}
