import type { WorkflowDefaults } from "@/lib/config/schemas";

export type FieldPath = string;

export type WorkflowDefaultsBlock = keyof WorkflowDefaults;

// Re-exported from the cascade resolver — the form renders against the SAME
// object the server treats as "no config anywhere", so the settings page can
// never drift from what absent config actually means.
export { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";

export function deepGet(obj: unknown, path: FieldPath): unknown {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function deepSet<T>(obj: T, path: FieldPath, value: unknown): T {
  const keys = path.split(".");
  const clone = structuredClone(obj);
  let cur: Record<string, unknown> = clone as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (cur[k] == null || typeof cur[k] !== "object") {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return clone;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

export function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const stripped = stripUndefinedDeep(entry);
    if (
      stripped &&
      typeof stripped === "object" &&
      !Array.isArray(stripped) &&
      Object.keys(stripped).length === 0
    ) {
      continue;
    }
    result[key] = stripped;
  }

  return result;
}

export const ALL_FIELD_PATHS: readonly FieldPath[] = [
  "baseDir",
  "defaultAgentBackend",
  "branchPrefix",
  "agentBackends.claude.model",
  "agentBackends.claude.reasoningEffort",
  "agentBackends.claude.timeoutMs",
  "agentBackends.codex.model",
  "agentBackends.codex.reasoningEffort",
  "agentBackends.codex.fastMode",
  "agentBackends.codex.timeoutMs",
  "maxTurns",
  "maxConcurrentQueries",
  "preMergeTimeoutMs",
  "idleQuerySessionTtlMs",
  "tailscaleEnabled",
  "pushNotification.enabled",
  "pushNotification.provider",
  "pushNotification.serverUrl",
  "pushNotification.topic",
  "pushNotification.triggers.jobCompleted",
  "pushNotification.triggers.waitingForInput",
  "pushNotification.triggers.workflowCompleted",
  "pushNotification.triggers.workflowHalted",
  "pushNotification.triggers.conversationIdle",
  "pushNotification.triggers.specApprovalRequested",
  "pushNotification.triggers.specApprovalGranted",
  "pushNotification.triggers.specPolicyAdmitted",
  "pushNotification.triggers.planRepair",
  "compaction.backend",
  "compaction.conversationModel",
  "compaction.messageModel",
  "compaction.effort",
  "compaction.timeoutMs",
  "conversationNaming.enabled",
  "conversationNaming.backend",
  "conversationNaming.model",
  "conversationNaming.effort",
  "conversationNaming.timeoutMs",
  "workflowDefaults.implementer",
  "workflowDefaults.collaboration",
  "workflowDefaults.contextValidator",
  "workflowDefaults.scriptValidator",
  "workflowDefaults.askUserQuestions",
  "workflowDefaults.iterationPolicy",
  "workflowDefaults.circuitBreaker",
  "workflowDefaults.mutability",
  "workflowDefaults.planRepair",
];
