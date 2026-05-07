import { describe, it, expect, beforeEach } from "vitest";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  getConversationRuntime,
  cleanupConversationRuntime,
  hasConversationRuntime,
  getRegisteredConversationKeys,
  rejectActiveQuestionResolver,
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
      registerConversationRuntime(key, { abortController: controller });

      cleanupConversationRuntime(key);

      expect(controller.signal.aborted).toBe(true);
      expect(hasConversationRuntime(key)).toBe(false);
    });

    it("calls releaseConversationLock if present", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      let lockReleased = false;
      registerConversationRuntime(key, {
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

  describe("hasConversationRuntime", () => {
    it("returns true when registered", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });
      expect(hasConversationRuntime(key)).toBe(true);
    });

    it("returns false when not registered", () => {
      expect(hasConversationRuntime("missing")).toBe(false);
    });
  });

  describe("rejectActiveQuestionResolver", () => {
    it("rejects the resolver, clears it, and returns true", async () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      let captured: unknown;
      const promise = new Promise<unknown>((resolve, reject) => {
        registerConversationRuntime(key, {
          abortController: new AbortController(),
          activeQuestionResolver: {
            resolve: () => {},
            reject: (err) => {
              captured = err;
              reject(err);
            },
          },
        });
        void resolve;
      });

      const result = rejectActiveQuestionResolver(key, "Prompt aborted");

      expect(result).toBe(true);
      await expect(promise).rejects.toBeDefined();
      expect((captured as Error).message).toBe("Prompt aborted");
      expect(
        getConversationRuntime(key)?.activeQuestionResolver,
      ).toBeUndefined();
    });

    it("returns false when there is no active resolver", () => {
      const key = conversationRuntimeKey("/repo", "sess-1", "conv-1");
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });
      expect(rejectActiveQuestionResolver(key, "abort")).toBe(false);
    });

    it("returns false for unknown key", () => {
      expect(rejectActiveQuestionResolver("nope", "abort")).toBe(false);
    });
  });

  describe("getRegisteredConversationKeys", () => {
    it("returns all registered keys", () => {
      registerConversationRuntime("k1", {
        abortController: new AbortController(),
      });
      registerConversationRuntime("k2", {
        abortController: new AbortController(),
      });
      expect(getRegisteredConversationKeys()).toEqual(
        expect.arrayContaining(["k1", "k2"]),
      );
    });
  });
});
