import { describe, expect, it } from "vitest";
import { createStartupRegistrar } from "./instrumentation.node";

describe("createStartupRegistrar", () => {
  it("rehydrates conversation actors before envelope recovery and notifications init", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => {
          calls.push("rehydrate");
          return 0;
        },
      }),
      initNotificationDb: () => {
        calls.push("notifications");
      },
      setConfigReader: () => {
        calls.push("setConfigReader");
      },
      readConfig: async () => {
        calls.push("readConfig");
        throw new Error(
          "readConfig should not be called during startup wiring",
        );
      },
      startMergeDetection: async () => {
        calls.push("merge");
      },
      recoverActiveWorkflowEnvelopes: async () => {
        calls.push("envelope-recovery");
        return {
          scanned: 0,
          failed: 0,
          preservedPaused: 0,
          preservedRunning: 0,
          movedToPaused: 0,
        };
      },
    });

    await register();

    expect(calls.indexOf("rehydrate")).toBeLessThan(
      calls.indexOf("envelope-recovery"),
    );
    expect(calls).toContain("envelope-recovery");
    expect(calls).toContain("notifications");
  });

  it("invokes envelope recovery and surfaces failures without breaking startup", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => 0,
      }),
      initNotificationDb: () => {
        calls.push("notifications");
      },
      setConfigReader: () => {},
      readConfig: async () => {
        throw new Error(
          "readConfig should not be called during startup wiring",
        );
      },
      startMergeDetection: async () => {},
      recoverActiveWorkflowEnvelopes: async () => {
        calls.push("envelope-recovery-failed");
        throw new Error("simulated recovery failure");
      },
    });

    await expect(register()).resolves.not.toThrow();
    expect(calls).toContain("envelope-recovery-failed");
    expect(calls).toContain("notifications");
  });
});
