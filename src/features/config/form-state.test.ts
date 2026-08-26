import { describe, it, expect } from "vitest";
import { pushNotificationConfigSchema } from "@/lib/notifications/schemas";
import {
  DEFAULT_PLAN_REPAIR_POLICY,
  graphWorkflowPlanRepairPolicySchema,
} from "@/lib/workflow-graph/config-schemas";
import { SEEDED_WORKFLOW_DEFAULTS as canonicalSeededDefaults } from "@/lib/workflow-graph/resolve-config";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import {
  ALL_FIELD_PATHS,
  SEEDED_WORKFLOW_DEFAULTS,
  deepGet,
  deepSet,
  deepEqual,
  stripUndefinedDeep,
} from "./form-state";

// The seeded defaults exist so UI surfaces can render before global config
// loads. Each surface must share THE SAME OBJECT as the cascade resolver's
// fallback — a diverging copy silently substitutes stale defaults for real
// cascade values (identity, not equality, so a re-copied literal fails).
describe("seeded workflow defaults single source", () => {
  it("form-state re-exports the canonical resolver defaults", () => {
    expect(SEEDED_WORKFLOW_DEFAULTS).toBe(canonicalSeededDefaults);
  });

  it("the planRepair seeded default is the schema-derived policy object", () => {
    expect(SEEDED_WORKFLOW_DEFAULTS.planRepair).toBe(
      DEFAULT_PLAN_REPAIR_POLICY,
    );
  });

  it("DEFAULT_PLAN_REPAIR_POLICY matches what the schema defaults produce", () => {
    expect(graphWorkflowPlanRepairPolicySchema.parse({})).toEqual(
      DEFAULT_PLAN_REPAIR_POLICY,
    );
  });
});

describe("deepGet", () => {
  it("returns nested value by dot path", () => {
    expect(deepGet({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("returns undefined for missing path", () => {
    expect(deepGet({ a: { b: {} } }, "a.b.c")).toBeUndefined();
    expect(deepGet(null, "a")).toBeUndefined();
  });
});

describe("deepSet", () => {
  it("sets nested value by dot path without mutating original", () => {
    const original = { a: { b: 1 } };
    const next = deepSet(original, "a.b", 2);
    expect(next).toEqual({ a: { b: 2 } });
    expect(original).toEqual({ a: { b: 1 } });
  });
  it("creates missing intermediate objects", () => {
    expect(deepSet({}, "a.b.c", 5)).toEqual({ a: { b: { c: 5 } } });
  });
});

describe("deepEqual", () => {
  it("compares primitives and arrays", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
  it("compares nested objects", () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
  it("handles null and undefined", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe("ALL_FIELD_PATHS", () => {
  it("tracks the normalized default selector and each backend profile field", () => {
    for (const path of [
      "defaultAgentBackend",
      "agentBackends.claude.modelSelection",
      "agentBackends.claude.timeoutMs",
      "agentBackends.codex.modelSelection",
      "agentBackends.codex.timeoutMs",
    ]) {
      expect(ALL_FIELD_PATHS).toContain(path);
    }

    for (const legacyPath of [
      "defaultModel",
      "defaultEffort",
      "claudeTimeoutMs",
      "codex.enabled",
      "codex.model",
      "codex.reasoningEffort",
      "codex.timeoutMs",
    ]) {
      expect(ALL_FIELD_PATHS).not.toContain(legacyPath);
    }
  });

  // Derived from the catalog rather than hand-listed: a backend whose profile
  // BackendsSection renders but ALL_FIELD_PATHS omits is editable on screen and
  // silently unsaved — zero dirty fields, and the edit dropped from the PUT.
  it("tracks a profile field for every registered backend the settings section renders", () => {
    for (const entry of listBackendCatalogEntries()) {
      expect(ALL_FIELD_PATHS).toContain(
        `agentBackends.${entry.id}.modelSelection`,
      );
      expect(ALL_FIELD_PATHS).toContain(`agentBackends.${entry.id}.timeoutMs`);
    }
  });

  it("does not split model parameters into independently persisted fields", () => {
    for (const entry of listBackendCatalogEntries()) {
      expect(ALL_FIELD_PATHS).not.toContain(
        `agentBackends.${entry.id}.reasoningEffort`,
      );
      expect(ALL_FIELD_PATHS).not.toContain(
        `agentBackends.${entry.id}.fastMode`,
      );
    }
  });

  it("tracks the editable compaction fields so they are dirty-tracked and saved", () => {
    // Without these paths, changes in CompactionSection would never be detected
    // as dirty nor written by buildSavePayload.
    for (const path of [
      "compaction.backend",
      "compaction.conversationModelSelection",
      "compaction.messageModelSelection",
      "compaction.timeoutMs",
    ]) {
      expect(ALL_FIELD_PATHS).toContain(path);
    }
  });

  it("tracks the validation blocks so selector edits are dirty-tracked and saved", () => {
    // Without these block paths, edits in the Script validator, Agent
    // validation, and Lane-merge validation sub-sections would never be
    // detected as dirty nor written by buildSavePayload.
    for (const path of [
      "workflowDefaults.scriptValidator",
      "workflowDefaults.agentValidation",
      "workflowDefaults.laneMergeValidation",
    ]) {
      expect(ALL_FIELD_PATHS).toContain(path);
    }
  });

  it("tracks the global validation budget and timeout fields", () => {
    for (const path of [
      "validation.concurrencyLimit",
      "validation.defaultTimeoutMs",
    ]) {
      expect(ALL_FIELD_PATHS).toContain(path);
    }
  });

  it("tracks the editable conversation naming fields so they are dirty-tracked and saved", () => {
    // Without these paths, changes in NamingSection would never be detected
    // as dirty nor written by buildSavePayload.
    for (const path of [
      "conversationNaming.enabled",
      "conversationNaming.backend",
      "conversationNaming.modelSelection",
      "conversationNaming.timeoutMs",
    ]) {
      expect(ALL_FIELD_PATHS).toContain(path);
    }
  });

  it("tracks every push notification trigger so they are dirty-tracked and saved", () => {
    // A trigger key missing here renders in NotificationsSection but never
    // dirties the form nor enters buildSavePayload, so the toggle silently
    // fails to persist. Derive the expected paths from the schema so new
    // triggers cannot drift out of sync.
    const triggerKeys = Object.keys(
      pushNotificationConfigSchema.parse({}).triggers,
    );
    expect(triggerKeys.length).toBeGreaterThan(0);
    for (const key of triggerKeys) {
      expect(ALL_FIELD_PATHS).toContain(`pushNotification.triggers.${key}`);
    }
  });
});

describe("stripUndefinedDeep", () => {
  it("removes undefined keys and empty nested objects", () => {
    expect(
      stripUndefinedDeep({ a: 1, b: undefined, c: { d: undefined } }),
    ).toEqual({
      a: 1,
    });
  });
  it("preserves arrays as-is", () => {
    expect(stripUndefinedDeep({ list: [1, 2, 3] })).toEqual({
      list: [1, 2, 3],
    });
  });
});
