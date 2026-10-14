import { describe, expect, it } from "vitest";
import {
  createStartupRegistrar,
  type StartupDeps,
} from "./instrumentation.node";
import { globalConfigSchema } from "./lib/config/schemas";

function startup(overrides: Partial<StartupDeps> = {}): StartupDeps {
  return {
    runStateMigrations: async () => [],
    initNotificationDb: () => {},
    setConfigReader: () => {},
    readConfig: async () => globalConfigSchema.parse({}),
    recoverActiveWorkflowEnvelopes: async () => ({
      scanned: 0,
      failed: 0,
      preservedPaused: 0,
      preservedRunning: 0,
      movedToPaused: 0,
    }),
    ensureAgentToken: async () => "test-token",
    installCli: async () => ({ installed: false, reason: "bundle_missing" }),
    publishManagedSkills: async () => null,
    recordServerBaseUrl: () => "http://127.0.0.1:3000",
    verifyServerBaseUrl: () => {},
    sweepInterruptedCompactions: () => 0,
    initializeValidationService: async () => {},
    recoverInterruptedConversationSnapshots: async () => 0,
    ...overrides,
  };
}

describe("startup core composition", () => {
  it("aborts before any recovery when state migrations fail", async () => {
    let recovered = false;
    const register = createStartupRegistrar(
      startup({
        runStateMigrations: async () => {
          throw new Error("cutover refused");
        },
        bootSupervision: async () => {
          recovered = true;
          return { restoredRuns: 0, reconciledOwners: 0 };
        },
      }),
    );
    await expect(register()).rejects.toThrow("cutover refused");
    expect(recovered).toBe(false);
  });

  it("restores core turns after launch resources and starts wakes after recovery", async () => {
    const order: string[] = [];
    await createStartupRegistrar(
      startup({
        runStateMigrations: async () => {
          order.push("migrations");
          return [];
        },
        ensureAgentToken: async () => {
          order.push("token");
          return "test-token";
        },
        installCli: async () => {
          order.push("cli");
          return { installed: false, reason: "bundle_missing" };
        },
        publishManagedSkills: async () => {
          order.push("skills");
          return null;
        },
        recoverInterruptedSubscriptionDeliveries: async () => {
          order.push("uncertainty");
          return 0;
        },
        bootSupervision: async () => {
          order.push("core");
          return { restoredRuns: 1, reconciledOwners: 0 };
        },
        startActiveSubscriptionWakes: async () => {
          order.push("wakes");
        },
      }),
    )();
    expect(order).toEqual([
      "migrations",
      "token",
      "cli",
      "skills",
      "uncertainty",
      "core",
      "wakes",
    ]);
  });
});
