/**
 * The REAL production task runners over caller-scripted provider ports
 * (test-only).
 *
 * `ClaudeTaskRunner` and `CodexTaskRunner` are adapter internals, so a consumer
 * outside `src/lib/agent-backends/` cannot construct one — yet proving that a
 * policy survives every hop down to the runner (the write envelope, prompt
 * authority, the role transport) requires the real runner, not a
 * request-shaped assertion that stops at the seam. Same rationale as
 * `createEnvCapturingCodexTaskRunner`, generalized: the caller supplies the
 * provider port it needs to observe or script, and gets back the neutral
 * `AgentTaskRunner`.
 *
 * Every dep other than the provider port defaults to an inert test value, so a
 * scripted run resolves no real server identity and reaches no real process.
 * A caller that needs to observe one of those (child env, MCP discovery,
 * pricing) overrides it.
 */

import {
  ClaudeTaskRunner,
  type ClaudeTaskRunnerDeps,
} from "../claude/task-runner";
import {
  CodexTaskRunner,
  type CodexTaskRunnerDeps,
} from "../codex/task-runner";
import type { AgentTaskRunner } from "../task";

/** Config location a scripted run reports; never read from disk. */
export const SCRIPTED_CONFIG_DIR = "/test/config";

/** The provider port plus any dep the caller wants to observe or pin. */
export type ScriptedClaudeTaskPorts = Pick<ClaudeTaskRunnerDeps, "runQuery"> &
  Partial<ClaudeTaskRunnerDeps>;

export type ScriptedCodexTaskPorts = Pick<CodexTaskRunnerDeps, "createCodex"> &
  Partial<CodexTaskRunnerDeps>;

export function createScriptedClaudeTaskRunner(
  ports: ScriptedClaudeTaskPorts,
): AgentTaskRunner {
  return new ClaudeTaskRunner({
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => SCRIPTED_CONFIG_DIR,
    ...ports,
  });
}

export function createScriptedCodexTaskRunner(
  ports: ScriptedCodexTaskPorts,
): AgentTaskRunner {
  return new CodexTaskRunner({
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => SCRIPTED_CONFIG_DIR,
    ensureManagedSkillsBridge: async () =>
      ({ status: "skipped", reason: "no_bundle" }) as const,
    ...ports,
  });
}
