import { describe, expect, it } from "vitest";
import { createStartupRegistrar } from "./instrumentation.node";

describe("createStartupRegistrar", () => {
  it("runs the graph workflow cutover before rehydrating conversation actors", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      runGraphWorkflowContextValidatorCutover: async () => {
        calls.push("cutover");
        return {
          status: "completed",
          markerPath: "/tmp/marker.json",
          stateFilePath: "/tmp/state.json",
          stateBackupPath: null,
          workflowDefinitionsBackupPath: null,
          summary: {
            sessionsScanned: 0,
            sessionsCleared: 0,
            activeExecutionsCleared: 0,
            archivedExecutionsCleared: 0,
          },
        };
      },
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

    expect(calls[0]).toBe("cutover");
    expect(calls.indexOf("cutover")).toBeLessThan(calls.indexOf("rehydrate"));
    expect(calls).toContain("envelope-recovery");
  });

  it("invokes envelope recovery and surfaces failures without breaking startup", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      runGraphWorkflowContextValidatorCutover: async () => ({
        status: "completed",
        markerPath: "/tmp/marker.json",
        stateFilePath: "/tmp/state.json",
        stateBackupPath: null,
        workflowDefinitionsBackupPath: null,
        summary: {
          sessionsScanned: 0,
          sessionsCleared: 0,
          activeExecutionsCleared: 0,
          archivedExecutionsCleared: 0,
        },
      }),
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
