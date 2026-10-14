import { describe, expect, it } from "vitest";
import { materializeGlobalConfig } from "@/lib/config/loader";
import { rawGlobalConfigSchema } from "@/lib/config/schemas";
import {
  createMemoryContributionGate,
  createMemoryPolicyResolver,
  memoryPolicyRoleFor,
  resolveMemoryDeliveryPolicy,
  resolveMemoryIndexBudget,
} from "./delivery-policy";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
} from "./schemas";

function config(memory: unknown = {}) {
  return materializeGlobalConfig(rawGlobalConfigSchema.parse({ memory }));
}
describe("memory policies after engine retirement", () => {
  it("maps historical conversation roles to configured role policies", () => {
    expect(memoryPolicyRoleFor(null)).toBe("conversation");
    expect(memoryPolicyRoleFor("planner")).toBe("conversation");
    expect(memoryPolicyRoleFor("initialization")).toBe("conversation");
    expect(memoryPolicyRoleFor("iteration")).toBe("implementer");
    expect(memoryPolicyRoleFor("validator")).toBe("validator");
  });
  it("uses independent global defaults for ordinary, implementer and validator conversations", () => {
    const current = config();
    expect(resolveMemoryDeliveryPolicy(current, null)).toMatchObject({
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    });
    expect(resolveMemoryDeliveryPolicy(current, "iteration")).toMatchObject({
      read: { value: "ambient" },
      contribute: { value: "on" },
    });
    expect(resolveMemoryDeliveryPolicy(current, "validator")).toMatchObject({
      read: { value: "off" },
      contribute: { value: "off" },
    });
  });
  it("reads each role from memory.roles and defaults each policy half independently", () => {
    const current = config({
      roles: {
        implementer: { read: "linked-only" },
        validator: { contribute: "on" },
      },
    });
    expect(resolveMemoryDeliveryPolicy(current, "iteration")).toMatchObject({
      read: { value: "linked-only" },
      contribute: { value: "on" },
    });
    expect(resolveMemoryDeliveryPolicy(current, "validator")).toMatchObject({
      read: { value: "off" },
      contribute: { value: "on" },
    });
    expect(resolveMemoryDeliveryPolicy(current, null).read.value).toBe(
      "ambient",
    );
  });
  it("re-reads role settings at the next resolution", async () => {
    let current = config();
    const resolver = createMemoryPolicyResolver({
      async readConfig() {
        return current;
      },
    });
    const subject = {
      projectPath: "/project",
      conversation: { kind: "project" as const },
      role: "validator" as const,
    };
    expect((await resolver.resolve(subject)).read.value).toBe("off");
    current = config({ roles: { validator: { read: "ambient" } } });
    expect((await resolver.resolve(subject)).read.value).toBe("ambient");
  });
  it("uses only the global index budget", () => {
    expect(resolveMemoryIndexBudget(config())).toEqual({
      bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
      hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
    });
  });
  it("allows the user, refuses unplaced agents, and enforces the placed role contribution policy", async () => {
    const resolver = createMemoryPolicyResolver({
      async readConfig() {
        return config();
      },
    });
    const gate = createMemoryContributionGate({
      resolver,
      async locateConversation(id) {
        return id === "known"
          ? {
              projectPath: "/project",
              conversation: { kind: "project" },
              role: "validator",
            }
          : null;
      },
    });
    expect(
      await gate.decide({
        kind: "user",
        visibility: { projectPath: null, session: null },
      }),
    ).toEqual({ allowed: true });
    expect(
      await gate.decide({
        kind: "agent",
        conversationId: "unknown",
        visibility: { projectPath: "/project", session: null },
      }),
    ).toMatchObject({ allowed: false, reason: "caller_unresolved" });
    expect(
      await gate.decide({
        kind: "agent",
        conversationId: "known",
        visibility: { projectPath: "/project", session: null },
      }),
    ).toMatchObject({ allowed: false, reason: "contribution_off" });
  });
});
