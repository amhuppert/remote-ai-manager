import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
import { describe, it, expect, beforeEach } from "vitest";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
  _resetForTesting,
  type ConversationRuntimeState,
} from "./runtime-state";

describe("conversation runtime-state", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("conversationRuntimeKey", () => {
    it("builds a key from projectPath, sessionName, and conversationId", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-abc");
      expect(key).toBe("/repo::sess-1::conv-abc");
    });
  });

  describe("registerConversationRuntime / getConversationRuntime", () => {
    it("stores and retrieves runtime state", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      const state: ConversationRuntimeState = {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      };
      registerConversationRuntime(key, state);
      expect(getConversationRuntime(key)).toBe(state);
    });

    it("returns undefined for unknown key", () => {
      expect(getConversationRuntime("unknown")).toBeUndefined();
    });
  });

  describe("cleanupConversationRuntime", () => {
    it("aborts the controller and removes from registry", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      const controller = new AbortController();
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: controller,
      });

      cleanupConversationRuntime(key);

      expect(controller.signal.aborted).toBe(true);
      expect(getConversationRuntime(key)).toBeUndefined();
    });

    it("calls releaseConversationLock if present", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      let lockReleased = false;
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
        releaseConversationLock: () => {
          lockReleased = true;
        },
      });

      cleanupConversationRuntime(key);
      expect(lockReleased).toBe(true);
    });

    it("calls releaseQuerySlot if present", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      let slotReleased = false;
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
        releaseQuerySlot: () => {
          slotReleased = true;
        },
      });

      cleanupConversationRuntime(key);
      expect(slotReleased).toBe(true);
    });

    it("is a no-op for unknown key", () => {
      expect(() => cleanupConversationRuntime("nope")).not.toThrow();
    });
  });
});
