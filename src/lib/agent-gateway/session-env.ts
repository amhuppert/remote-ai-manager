import path from "node:path";

/**
 * The env contract injected into every spawned agent session
 * (docs/design/cc-cli/01 §2): identity + server coordinates for cctl, a PATH
 * prepend that makes the installed binary resolvable, and a raised Bash
 * ceiling so `cctl --wait` flows are not killed by the harness default.
 */

/** 30 min — long `cctl --wait` flows (codex runs) exceed the 10-min default. */
const BASH_MAX_TIMEOUT_MS_DEFAULT = "1800000";

export type SessionEnv = Record<string, string | undefined>;

export interface SessionEnvContractInput {
  baseEnv: SessionEnv;
  /** Recorded at boot; null only if startup has not run (var is then omitted). */
  serverUrl: string | null;
  /** Instance token; null only if startup failed to provision one (omitted). */
  apiToken: string | null;
  project: string;
  session: string;
  conversationId: string;
  configDir: string;
  /**
   * Graph-workflow lane identity, injected ONLY for lane (implementer)
   * conversations so `cctl workflow …` resolves its execution/context from env
   * without flags (doc 01 §2). Both are set together or not at all — every
   * non-lane session omits both.
   */
  workflowExecutionId?: string;
  workflowContextId?: string;
}

export function buildSessionEnvContract(
  input: SessionEnvContractInput,
): SessionEnv {
  const env: SessionEnv = { ...input.baseEnv };

  if (input.serverUrl !== null) env["CC_SERVER_URL"] = input.serverUrl;
  if (input.apiToken !== null) env["CC_API_TOKEN"] = input.apiToken;
  env["CC_PROJECT"] = input.project;
  env["CC_SESSION"] = input.session;
  env["CC_CONVERSATION_ID"] = input.conversationId;
  if (input.workflowExecutionId !== undefined)
    env["CC_WORKFLOW_EXECUTION_ID"] = input.workflowExecutionId;
  if (input.workflowContextId !== undefined)
    env["CC_WORKFLOW_CONTEXT_ID"] = input.workflowContextId;
  env["BASH_MAX_TIMEOUT_MS"] ??= BASH_MAX_TIMEOUT_MS_DEFAULT;

  const binDir = path.join(input.configDir, "bin");
  const currentPath = env["PATH"];
  if (currentPath === undefined || currentPath === "") {
    env["PATH"] = binDir;
  } else if (!currentPath.split(path.delimiter).includes(binDir)) {
    env["PATH"] = `${binDir}${path.delimiter}${currentPath}`;
  }

  return env;
}
