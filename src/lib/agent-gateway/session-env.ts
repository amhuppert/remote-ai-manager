import path from "node:path";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";

const logger = createLogger("session-env");

/**
 * The env contract injected into every spawned agent session
 * (docs/design/cc-cli/01 §2): identity + server coordinates for cctl, a PATH
 * prepend that makes the installed binary resolvable, and a raised Bash
 * ceiling so `cctl --wait` flows are not killed by the harness default.
 *
 * The contract OWNS the CC_ namespace: every CC_* key inherited from the base
 * env is neutralized to "" before the contract vars are set, so an ambient
 * value (e.g. a prod CC_SERVER_URL/CC_API_TOKEN leaking into a nested dev
 * instance, or an outer lane's CC_WORKFLOW_* ids) can never reach a spawned
 * agent's cctl resolution. Neutralization is an empty-string override, NOT a
 * delete: the Claude Agent SDK merges this env over process.env (see
 * shared/child-env.ts), so a deleted key resurrects the parent's ambient
 * value — "" wins under both merge and replace semantics, and every cctl env
 * read is a falsy check, so "" behaves exactly like unset.
 *
 * Conversation scope is carried EXPLICITLY as `CC_CONVERSATION_SCOPE` (D3), not
 * inferred by the agent from the shape of `CC_SESSION`. A project conversation
 * gets `CC_CONVERSATION_SCOPE=project` and a neutralized `CC_SESSION=""`; cctl
 * routes on the discriminator, and any consumer that still needs a session
 * fails with its ordinary usage error instead of building a sentinel URL.
 */

/** 30 min — long `cctl --wait` flows (agent runs) exceed the 10-min default. */
const BASH_MAX_TIMEOUT_MS_DEFAULT = "1800000";

export type SessionEnv = Record<string, string | undefined>;

export interface SessionEnvContractInput {
  baseEnv: SessionEnv;
  /** Recorded at boot; null only if startup has not run (var is then omitted). */
  serverUrl: string | null;
  /** Instance token; null only if startup failed to provision one (omitted). */
  apiToken: string | null;
  /**
   * The conversation this agent is running as, in the public scope vocabulary
   * (D1). The discriminated union — not a nullable session name — is what makes
   * `CC_SESSION` neutralization structural: a project conversation has no field
   * for a session name to occupy, so there is nothing to accidentally export.
   */
  target: ConversationTarget;
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

/** Override every inherited CC_* key with "" (in place). */
export function neutralizeAmbientCcEnv(env: SessionEnv): SessionEnv {
  for (const key of Object.keys(env)) {
    if (key.startsWith("CC_")) env[key] = "";
  }
  return env;
}

export function buildSessionEnvContract(
  input: SessionEnvContractInput,
): SessionEnv {
  // Key names only — an ambient CC_API_TOKEN value must never reach the logs.
  const contaminatedKeys = Object.keys(input.baseEnv).filter(
    (key) => key.startsWith("CC_") && input.baseEnv[key],
  );
  if (contaminatedKeys.length > 0) {
    logger.info("session-env.ambient_cc_env_neutralized", {
      conversationId: input.target.conversationId,
      keys: contaminatedKeys,
    });
  }

  const env: SessionEnv = neutralizeAmbientCcEnv({ ...input.baseEnv });

  if (input.serverUrl !== null) env["CC_SERVER_URL"] = input.serverUrl;
  if (input.apiToken !== null) env["CC_API_TOKEN"] = input.apiToken;
  env["CC_PROJECT"] = input.target.projectName;
  env["CC_CONVERSATION_SCOPE"] = input.target.scope;
  // A project conversation exports CC_SESSION as an explicitly neutralized ""
  // rather than omitting it: omission resurrects the ambient session under the
  // merge described above, and the sentinel must never reach the agent as a
  // session identity. Every cctl session-env read is a falsy check, so ""
  // produces the ordinary "no session" usage error at the point of use.
  env["CC_SESSION"] =
    input.target.scope === "session" ? input.target.sessionName : "";
  env["CC_CONVERSATION_ID"] = input.target.conversationId;
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
