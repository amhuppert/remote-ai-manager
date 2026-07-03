import { describe, expect, it } from "vitest";
import { createStartupRegistrar } from "./instrumentation.node";
import { getTraceContext, type TraceContext } from "./lib/logging";

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
      runStateMigrations: async () => {
        calls.push("migrations");
        return [];
      },
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
      ensureAgentToken: async () => "test-token",
      installCli: async () =>
        ({ installed: false, reason: "bundle_missing" }) as const,
      recordServerBaseUrl: () => "http://127.0.0.1:3000",
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

    expect(calls.indexOf("migrations")).toBeLessThan(
      calls.indexOf("rehydrate"),
    );
    expect(calls.indexOf("rehydrate")).toBeLessThan(
      calls.indexOf("envelope-recovery"),
    );
    expect(calls).toContain("envelope-recovery");
    expect(calls).toContain("notifications");
  });

  it("runs rehydrate and envelope recovery inside distinct startup traces", async () => {
    const traces: Record<string, TraceContext | undefined> = {};
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => {
          traces["rehydrate"] = getTraceContext();
          return 0;
        },
      }),
      runStateMigrations: async () => [],
      initNotificationDb: () => {},
      setConfigReader: () => {},
      readConfig: async () => ({}) as never,
      ensureAgentToken: async () => "test-token",
      installCli: async () =>
        ({ installed: false, reason: "bundle_missing" }) as const,
      recordServerBaseUrl: () => "http://127.0.0.1:3000",
      recoverActiveWorkflowEnvelopes: async () => {
        traces["recover"] = getTraceContext();
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

    expect(traces["rehydrate"]?.action).toBe("startup:rehydrate-conversations");
    expect(traces["recover"]?.action).toBe(
      "startup:recover-workflow-envelopes",
    );
    expect(traces["rehydrate"]?.traceId).toBeTypeOf("string");
    expect(traces["recover"]?.traceId).toBeTypeOf("string");
    expect(traces["rehydrate"]?.traceId).not.toBe(traces["recover"]?.traceId);
  });

  it("invokes envelope recovery and surfaces failures without breaking startup", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => 0,
      }),
      runStateMigrations: async () => [],
      initNotificationDb: () => {
        calls.push("notifications");
      },
      setConfigReader: () => {},
      readConfig: async () => {
        throw new Error(
          "readConfig should not be called during startup wiring",
        );
      },
      ensureAgentToken: async () => "test-token",
      installCli: async () =>
        ({ installed: false, reason: "bundle_missing" }) as const,
      recordServerBaseUrl: () => "http://127.0.0.1:3000",
      recoverActiveWorkflowEnvelopes: async () => {
        calls.push("envelope-recovery-failed");
        throw new Error("simulated recovery failure");
      },
    });

    await expect(register()).resolves.not.toThrow();
    expect(calls).toContain("envelope-recovery-failed");
    expect(calls).toContain("notifications");
  });

  it("ensures the agent token after migrations and before conversations rehydrate", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => {
          calls.push("rehydrate");
          return 0;
        },
      }),
      runStateMigrations: async () => {
        calls.push("migrations");
        return [];
      },
      initNotificationDb: () => {},
      setConfigReader: () => {},
      readConfig: async () => ({}) as never,
      ensureAgentToken: async () => {
        calls.push("token");
        return "test-token";
      },
      installCli: async () => {
        calls.push("install");
        return { installed: false, reason: "bundle_missing" } as const;
      },
      recordServerBaseUrl: () => {
        calls.push("record-url");
        return "http://127.0.0.1:3000";
      },
      recoverActiveWorkflowEnvelopes: async () => ({
        scanned: 0,
        failed: 0,
        preservedPaused: 0,
        preservedRunning: 0,
        movedToPaused: 0,
      }),
    });

    await register();

    expect(calls.indexOf("migrations")).toBeLessThan(calls.indexOf("token"));
    expect(calls.indexOf("token")).toBeLessThan(calls.indexOf("rehydrate"));
    expect(calls.indexOf("record-url")).toBeLessThan(
      calls.indexOf("rehydrate"),
    );
    expect(calls.indexOf("install")).toBeLessThan(calls.indexOf("rehydrate"));
  });

  it("survives a failing token step without breaking startup", async () => {
    const calls: string[] = [];
    const register = createStartupRegistrar({
      loadConversationManager: async () => ({
        rehydrateConversationActors: async () => {
          calls.push("rehydrate");
          return 0;
        },
      }),
      runStateMigrations: async () => [],
      initNotificationDb: () => {},
      setConfigReader: () => {},
      readConfig: async () => ({}) as never,
      ensureAgentToken: async () => {
        throw new Error("disk full");
      },
      installCli: async () => {
        throw new Error("install exploded");
      },
      recordServerBaseUrl: () => "http://127.0.0.1:3000",
      recoverActiveWorkflowEnvelopes: async () => ({
        scanned: 0,
        failed: 0,
        preservedPaused: 0,
        preservedRunning: 0,
        movedToPaused: 0,
      }),
    });

    await expect(register()).resolves.not.toThrow();
    expect(calls).toContain("rehydrate");
  });
});
