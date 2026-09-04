import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { materializeGlobalConfig } from "@/lib/config/loader";
import {
  globalConfigSchema,
  perRepoConfigSchema,
  rawGlobalConfigSchema,
  type GlobalConfig,
} from "@/lib/config/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import {
  resolvedWorkflowSemanticDefinitionSchema,
  workflowSemanticDefinitionSchema,
  type ResolvedMemoryPolicyConfig,
} from "@/lib/workflow-graph/definition-schemas";
import {
  workflowDefinitionEditOperationSchema,
  workflowLiveEditOperationSchema,
} from "@/lib/workflows/edit-schemas";

import {
  createMemoryContributionGate,
  createMemoryPolicyResolver,
  memoryPolicyRoleFor,
  resolveMemoryDeliveryPolicy,
  resolveMemoryIndexBudget,
  type MemoryContributionGateDeps,
  type MemoryPolicySubject,
} from "./delivery-policy";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  type MemoryActor,
} from "./schemas";

const BASE_CONFIG = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends: {
    claude: {
      modelSelection: { modelId: "opus", parameters: { effort: "high" } },
      timeoutMs: 300_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "false", reasoning: "high" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: { modelId: "composer-2.5", parameters: { fast: "true" } },
      timeoutMs: null,
    },
  },
};

/** The effective config a settings file materializes to; `raw` is what sits on disk. */
function configFromDisk(raw: Record<string, unknown> = {}): GlobalConfig {
  return materializeGlobalConfig(
    rawGlobalConfigSchema.parse({ ...BASE_CONFIG, ...raw }),
  );
}

const PROJECT_PATH = "/repos/command-center";
const SESSION = "memory-lane";

/** A seeded per-context snapshot whose every half was set by a named tier. */
const CONTEXT_POLICY: ResolvedMemoryPolicyConfig = {
  implementer: {
    read: { value: "linked-only", source: "workflow" },
    contribute: { value: "off", source: "per-node" },
  },
  validator: {
    read: { value: "linked-only", source: "workflow" },
    contribute: { value: "on", source: "per-node" },
  },
};

describe("memoryPolicyRoleFor", () => {
  it("maps lane roles to the workflow roles the cascade knows and everything else to an ordinary conversation", () => {
    expect(memoryPolicyRoleFor(null)).toBe("conversation");
    expect(memoryPolicyRoleFor("planner")).toBe("conversation");
    expect(memoryPolicyRoleFor("initialization")).toBe("conversation");
    expect(memoryPolicyRoleFor("iteration")).toBe("implementer");
    expect(memoryPolicyRoleFor("validator")).toBe("validator");
  });
});

describe("resolveMemoryDeliveryPolicy (spec memory R10.2, D7)", () => {
  it("ships ambient+contribute for ordinary conversations and implementers, off+no-contribute for validators", () => {
    const config = configFromDisk();
    expect(resolveMemoryDeliveryPolicy(config, null, null)).toEqual({
      role: "conversation",
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    });
    expect(resolveMemoryDeliveryPolicy(config, "iteration", null)).toEqual({
      role: "implementer",
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    });
    expect(resolveMemoryDeliveryPolicy(config, "validator", null)).toEqual({
      role: "validator",
      read: { value: "off", source: "global" },
      contribute: { value: "off", source: "global" },
    });
  });

  it("reads ordinary conversations from memory.conversations, each half independently", () => {
    const config = configFromDisk({
      memory: { conversations: { read: "linked-only" } },
    });
    expect(resolveMemoryDeliveryPolicy(config, null, null)).toEqual({
      role: "conversation",
      read: { value: "linked-only", source: "global" },
      contribute: { value: "on", source: "global" },
    });
  });

  it("reads workflow roles from workflowDefaults.memory when the context carries no snapshot", () => {
    const config = configFromDisk({
      workflowDefaults: {
        memory: {
          validator: { read: "linked-only" },
          implementer: { contribute: "off" },
        },
      },
    });
    expect(resolveMemoryDeliveryPolicy(config, "validator", null)).toEqual({
      role: "validator",
      read: { value: "linked-only", source: "global" },
      contribute: { value: "off", source: "global" },
    });
    expect(resolveMemoryDeliveryPolicy(config, "iteration", null)).toEqual({
      role: "implementer",
      read: { value: "ambient", source: "global" },
      contribute: { value: "off", source: "global" },
    });
  });

  it("prefers the context's seeded snapshot over live global settings for workflow roles, keeping its provenance", () => {
    const config = configFromDisk({
      workflowDefaults: { memory: { validator: { read: "ambient" } } },
    });
    expect(
      resolveMemoryDeliveryPolicy(config, "validator", CONTEXT_POLICY),
    ).toEqual({
      role: "validator",
      read: { value: "linked-only", source: "workflow" },
      contribute: { value: "on", source: "per-node" },
    });
    expect(
      resolveMemoryDeliveryPolicy(config, "iteration", CONTEXT_POLICY),
    ).toEqual({
      role: "implementer",
      read: { value: "linked-only", source: "workflow" },
      contribute: { value: "off", source: "per-node" },
    });
  });

  it("never applies a context snapshot to an ordinary conversation", () => {
    expect(
      resolveMemoryDeliveryPolicy(configFromDisk(), null, CONTEXT_POLICY),
    ).toEqual({
      role: "conversation",
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    });
  });
});

describe("createMemoryPolicyResolver", () => {
  function resolver(overrides: {
    config?: GlobalConfig;
    contextPolicy?: ResolvedMemoryPolicyConfig | null;
  }) {
    const lookups: unknown[] = [];
    const instance = createMemoryPolicyResolver({
      async readConfig() {
        return overrides.config ?? configFromDisk();
      },
      async findContextPolicy(ref) {
        lookups.push(ref);
        return overrides.contextPolicy ?? null;
      },
    });
    return { resolve: instance.resolve, lookups };
  }

  const LANE: MemoryPolicySubject = {
    projectPath: PROJECT_PATH,
    conversation: { kind: "session", sessionName: SESSION },
    role: "validator",
    workflow: { executionId: "exec-1", contextId: "ctx-validate" },
  };

  it("looks the lane's context snapshot up by execution and context and resolves through it", async () => {
    const { resolve, lookups } = resolver({ contextPolicy: CONTEXT_POLICY });

    const policy = await resolve(LANE);

    expect(lookups).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION,
        executionId: "exec-1",
        contextId: "ctx-validate",
      },
    ]);
    expect(policy.read).toEqual({ value: "linked-only", source: "workflow" });
    expect(policy.contribute).toEqual({ value: "on", source: "per-node" });
  });

  it("falls back to the global role default when the execution carries no snapshot", async () => {
    const { resolve } = resolver({ contextPolicy: null });

    const policy = await resolve(LANE);

    expect(policy).toEqual({
      role: "validator",
      read: { value: "off", source: "global" },
      contribute: { value: "off", source: "global" },
    });
  });

  it("consults no execution for an ordinary conversation or a project conversation", async () => {
    const { resolve, lookups } = resolver({ contextPolicy: CONTEXT_POLICY });

    await resolve({ ...LANE, role: null, workflow: null });
    await resolve({
      projectPath: PROJECT_PATH,
      conversation: { kind: "project" },
      role: null,
      workflow: { executionId: "exec-1", contextId: "ctx-validate" },
    });

    expect(lookups).toEqual([]);
  });
});

describe("createMemoryContributionGate (spec memory R10.1)", () => {
  const USER: MemoryActor = {
    kind: "user",
    visibility: { projectPath: PROJECT_PATH, session: null },
  };
  function agent(conversationId: string): MemoryActor {
    return {
      kind: "agent",
      conversationId,
      visibility: { projectPath: PROJECT_PATH, session: null },
    };
  }

  function gate(overrides: Partial<MemoryContributionGateDeps> = {}) {
    const calls: string[] = [];
    const instance = createMemoryContributionGate({
      resolver: createMemoryPolicyResolver({
        async readConfig() {
          return configFromDisk();
        },
        async findContextPolicy(ref) {
          calls.push(`policy:${ref.executionId}/${ref.contextId}`);
          return ref.contextId === "ctx-open" ? CONTEXT_POLICY : null;
        },
      }),
      async locateConversation(conversationId) {
        calls.push(`locate:${conversationId}`);
        switch (conversationId) {
          case "conv-human":
            return {
              projectPath: PROJECT_PATH,
              conversation: { kind: "session", sessionName: SESSION },
              role: null,
            };
          case "conv-project":
            return {
              projectPath: PROJECT_PATH,
              conversation: { kind: "project" },
              role: null,
            };
          case "conv-validator":
          case "conv-validator-open":
          case "conv-validator-unbound":
            return {
              projectPath: PROJECT_PATH,
              conversation: { kind: "session", sessionName: SESSION },
              role: "validator",
            };
          case "conv-implementer":
            return {
              projectPath: PROJECT_PATH,
              conversation: { kind: "session", sessionName: SESSION },
              role: "iteration",
            };
          default:
            return null;
        }
      },
      async findLaneBinding(ref) {
        calls.push(`bind:${ref.conversationId}`);
        if (ref.conversationId === "conv-validator-open") {
          return { executionId: "exec-1", contextId: "ctx-open" };
        }
        if (ref.conversationId === "conv-validator-unbound") return null;
        return { executionId: "exec-1", contextId: "ctx-default" };
      },
      ...overrides,
    });
    return { decide: instance.decide, calls };
  }

  it("lets a human through without resolving anything", async () => {
    const { decide, calls } = gate();
    expect(await decide(USER)).toEqual({ allowed: true });
    expect(calls).toEqual([]);
  });

  it("lets ordinary session and project conversations contribute under the global conversation policy", async () => {
    const { decide, calls } = gate();
    expect(await decide(agent("conv-human"))).toEqual({ allowed: true });
    expect(await decide(agent("conv-project"))).toEqual({ allowed: true });
    expect(calls).toEqual(["locate:conv-human", "locate:conv-project"]);
  });

  it("refuses a validator lane by default, naming the policy and its tier", async () => {
    const { decide } = gate();
    expect(await decide(agent("conv-validator"))).toEqual({
      allowed: false,
      reason: "contribution_off",
      policy: {
        role: "validator",
        read: { value: "off", source: "global" },
        contribute: { value: "off", source: "global" },
      },
    });
  });

  it("honours a per-context snapshot that turns a validator's contribution on", async () => {
    const { decide, calls } = gate();
    expect(await decide(agent("conv-validator-open"))).toEqual({
      allowed: true,
    });
    expect(calls).toEqual([
      "locate:conv-validator-open",
      "bind:conv-validator-open",
      "policy:exec-1/ctx-open",
    ]);
  });

  it("falls back to the global role default for a lane conversation that is bound to no context", async () => {
    const { decide } = gate();
    const decision = await decide(agent("conv-validator-unbound"));
    expect(decision.allowed).toBe(false);
    if (decision.allowed || decision.reason !== "contribution_off") return;
    expect(decision.policy.contribute).toEqual({
      value: "off",
      source: "global",
    });
  });

  it("lets an implementer lane contribute by default", async () => {
    const { decide } = gate();
    expect(await decide(agent("conv-implementer"))).toEqual({ allowed: true });
  });

  it("refuses a caller Command Center cannot place in any conversation", async () => {
    const { decide } = gate();
    expect(await decide(agent("conv-ghost"))).toEqual({
      allowed: false,
      reason: "caller_unresolved",
      conversationId: "conv-ghost",
    });
  });
});

describe("memory policy settings on disk", () => {
  it("materializes a partial per-role block: the unstated half keeps the shipped default", () => {
    const config = configFromDisk({
      memory: { conversations: { contribute: "off" } },
      workflowDefaults: { memory: { validator: { read: "linked-only" } } },
    });
    expect(config.memory?.conversations).toEqual({
      read: "ambient",
      contribute: "off",
    });
    expect(config.workflowDefaults?.memory).toEqual({
      implementer: { read: "ambient", contribute: "on" },
      validator: { read: "linked-only", contribute: "off" },
    });
  });

  it("refuses a misspelled half and an unknown role rather than ignoring them", () => {
    for (const raw of [
      { memory: { conversations: { reads: "off" } } },
      { workflowDefaults: { memory: { reviewer: { read: "off" } } } },
      { workflowDefaults: { memory: { validator: { contribution: "on" } } } },
    ]) {
      const parsed = rawGlobalConfigSchema.safeParse(raw);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.code)).toContain(
          "unrecognized_keys",
        );
      }
    }
  });
});

describe("resolveMemoryIndexBudget (global settings only, R10.3)", () => {
  it("opens at the spec's default when settings carry no memory section", () => {
    expect(resolveMemoryIndexBudget(configFromDisk())).toEqual({
      bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
      hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
    });
  });

  it("reads a configured budget, defaulting whichever half is unset", () => {
    expect(
      resolveMemoryIndexBudget(
        configFromDisk({ memory: { indexBudget: { bytes: 4096, hooks: 80 } } }),
      ),
    ).toEqual({ bytes: 4096, hooks: 80 });
    expect(
      resolveMemoryIndexBudget(
        globalConfigSchema.parse({
          ...BASE_CONFIG,
          memory: { indexBudget: { hooks: 20 } },
        }),
      ),
    ).toEqual({ bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES, hooks: 20 });
  });

  it("refuses a budget below the frame floor and an unknown budget key on disk", () => {
    const tooSmall = rawGlobalConfigSchema.safeParse({
      memory: { indexBudget: { bytes: 512 } },
    });
    expect(tooSmall.success).toBe(false);
    const unknownKey = rawGlobalConfigSchema.safeParse({
      memory: { indexBudget: { chars: 4096 } },
    });
    expect(unknownKey.success).toBe(false);
    if (!unknownKey.success) {
      expect(unknownKey.error.issues.map((issue) => issue.code)).toContain(
        "unrecognized_keys",
      );
    }
  });

  /**
   * Every key path a schema declares, walked through its JSON-schema form so
   * object shapes, optionals, arrays, unions, and records are all covered.
   */
  function declaredKeyPaths(schema: z.ZodType): string[] {
    const paths: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown, path: string[]): void => {
      if (typeof node !== "object" || node === null || seen.has(node)) return;
      seen.add(node);
      const record = node as Record<string, unknown>;
      const properties = record["properties"];
      if (typeof properties === "object" && properties !== null) {
        for (const [key, value] of Object.entries(
          properties as Record<string, unknown>,
        )) {
          paths.push([...path, key].join("."));
          walk(value, [...path, key]);
        }
      }
      for (const key of ["items", "additionalProperties", "not"]) {
        if (record[key] !== undefined) walk(record[key], [...path, "[]"]);
      }
      for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
        const branches = record[key];
        if (Array.isArray(branches)) {
          for (const branch of branches) walk(branch, path);
        }
      }
      const defs = record["$defs"];
      if (typeof defs === "object" && defs !== null) {
        for (const [name, value] of Object.entries(
          defs as Record<string, unknown>,
        )) {
          walk(value, ["$defs", name]);
        }
      }
    };
    walk(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }), []);
    return paths;
  }

  it("declares the index budget in global settings and in no per-project, per-workflow, or per-conversation schema", () => {
    const budgetPaths = (schema: z.ZodType) =>
      declaredKeyPaths(schema).filter((path) => /budget/i.test(path));

    // The only home: global settings, on disk and materialized.
    for (const schema of [rawGlobalConfigSchema, globalConfigSchema]) {
      expect(budgetPaths(schema)).toEqual([
        "memory.indexBudget",
        "memory.indexBudget.bytes",
        "memory.indexBudget.hooks",
      ]);
    }

    // Nowhere else. Each schema is walked in full so a budget key added to any
    // nested override block — not just a top-level one — fails here.
    const nonGlobal: Array<[string, z.ZodType]> = [
      ["per-repo CommandCenter.json", perRepoConfigSchema],
      ["workflow definition", workflowSemanticDefinitionSchema],
      ["resolved working definition", resolvedWorkflowSemanticDefinitionSchema],
      ["definition edit operations", workflowDefinitionEditOperationSchema],
      ["live edit operations", workflowLiveEditOperationSchema],
      ["conversation state", conversationStateSchema],
      ["session state", sessionStateSchema],
    ];
    for (const [label, schema] of nonGlobal) {
      const paths = declaredKeyPaths(schema);
      expect(paths.length, `${label} declares keys`).toBeGreaterThan(0);
      expect(
        paths.filter((path) => /budget/i.test(path)),
        label,
      ).toEqual([]);
    }
  });
});

describe("hermetic task profiles (R10)", () => {
  /**
   * Task runs — isolated one-shots, collaboration second agents, structured-
   * output repair turns — never receive the ambient block: only the
   * conversation turn path (`executePromptForMachine`) composes it, and the
   * hermetic profile's env and MCP exclusions are pinned on the runners
   * themselves. Static, like the collaboration session-scope opt-out pin,
   * because the property is that these dispatch paths simply never reach the
   * provider — a runtime assertion would have to boot every dispatcher to
   * observe a call that is absent.
   */
  const REPO_ROOT = path.resolve(__dirname, "../../..");
  const TASK_DISPATCH_SOURCES = [
    "src/lib/agent-backends",
    "src/lib/workflows/primitives",
    "src/lib/workflows/collaboration",
    "src/lib/tickets/enrichment.ts",
    "src/lib/conversations/name-generation.ts",
    "src/lib/sessions/service.ts",
  ];
  const AMBIENT_BLOCK_IMPORTS =
    /index-live-context|getMemoryIndexContextProvider/;

  function productionSources(relative: string): string[] {
    const absolute = path.join(REPO_ROOT, relative);
    if (statSync(absolute).isFile()) return [relative];
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "testing" ? [] : productionSources(child);
      }
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [child]
        : [];
    });
  }

  it("composes the ambient index on no task dispatch path", () => {
    const sources = TASK_DISPATCH_SOURCES.flatMap(productionSources);
    expect(sources.length).toBeGreaterThan(100);

    const reaching = sources.filter((file) =>
      AMBIENT_BLOCK_IMPORTS.test(
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ),
    );

    expect(reaching).toEqual([]);
  });
});
