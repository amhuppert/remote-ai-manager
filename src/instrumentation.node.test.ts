import { describe, expect, it } from "vitest";
import { createStartupRegistrar } from "./instrumentation.node";

describe("createStartupRegistrar", () => {
  it("runs the graph workflow cutover before any startup state recovery", async () => {
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
      recoverStaleConversations: async () => {
        calls.push("recover");
        return 0;
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
    });

    await register();

    expect(calls[0]).toBe("cutover");
    expect(calls.indexOf("cutover")).toBeLessThan(calls.indexOf("recover"));
  });
});
