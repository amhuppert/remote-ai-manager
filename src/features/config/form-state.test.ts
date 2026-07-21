import { describe, it, expect } from "vitest";
import { pushNotificationConfigSchema } from "@/lib/notifications/schemas";
import {
  ALL_FIELD_PATHS,
  deepGet,
  deepSet,
  deepEqual,
  stripUndefinedDeep,
} from "./form-state";

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
      "agentBackends.claude.model",
      "agentBackends.claude.reasoningEffort",
      "agentBackends.claude.timeoutMs",
      "agentBackends.codex.model",
      "agentBackends.codex.reasoningEffort",
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

  it("tracks the editable compaction fields so they are dirty-tracked and saved", () => {
    // Without these paths, changes in CompactionSection would never be detected
    // as dirty nor written by buildSavePayload.
    for (const path of [
      "compaction.backend",
      "compaction.conversationModel",
      "compaction.messageModel",
      "compaction.effort",
      "compaction.timeoutMs",
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
