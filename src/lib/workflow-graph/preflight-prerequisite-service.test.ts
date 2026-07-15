import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  type WorkflowPrerequisite,
  type WorkflowSemanticDefinition,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";

import type { ProbeOutcome, PrerequisiteProbes } from "./prerequisite-probes";
import { createPreflightPrerequisiteService } from "./preflight-prerequisite-service";

// A hand-built PrerequisiteProbes that returns crafted outcomes and counts
// calls. This is DI (a real object implementing the interface), NOT a
// vi.mock of an internal module.
interface ProbeCall {
  kind: "path" | "skill";
  path?: string;
  skill?: string;
  backend?: AgentBackendId;
}

function makeCountingProbes(opts: {
  path?: (input: { worktreePath: string; path: string }) => ProbeOutcome;
  skill?: (input: {
    worktreePath: string;
    skill: string;
    backend: AgentBackendId;
  }) => ProbeOutcome;
}): { probes: PrerequisiteProbes; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const probes: PrerequisiteProbes = {
    async probePath(input) {
      calls.push({ kind: "path", path: input.path });
      return opts.path?.(input) ?? { satisfied: true };
    },
    async probeSkill(input) {
      calls.push({
        kind: "skill",
        skill: input.skill,
        backend: input.backend,
      });
      return opts.skill?.(input) ?? { satisfied: true };
    },
  };
  return { probes, calls };
}

function definitionWith(
  prerequisites: WorkflowPrerequisite[],
): WorkflowSemanticDefinition {
  return workflowSemanticDefinitionSchema.parse({
    charter: {
      mission: "M",
      sourcesOfTruth: [
        {
          rank: 1,
          id: "s1",
          label: "Source 1",
          type: "spec",
          locator: "spec.md",
          description: "D",
          accessPolicy: "worktree-relative",
        },
      ],
    },
    prerequisites,
  });
}

const WORKTREE = "/tmp/worktree";

describe("createPreflightPrerequisiteService — evaluate", () => {
  it("returns ok when all prerequisites are satisfied", async () => {
    const { probes, calls } = makeCountingProbes({});
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([
        { kind: "path", path: "a.txt" },
        { kind: "skill", skill: "do-thing", backend: "claude" },
      ]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude"]),
    });

    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("returns ok WITHOUT probing for an empty prerequisite set", async () => {
    const { probes, calls } = makeCountingProbes({});
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(0);
  });

  it("reports an unmet path prerequisite with reason absent", async () => {
    const { probes } = makeCountingProbes({
      path: () => ({ satisfied: false, reason: "absent" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([
        { kind: "path", path: "missing.txt", label: "the file" },
      ]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude"]),
    });

    expect(result).toEqual({
      status: "prerequisites_unmet",
      missing: [
        {
          kind: "path",
          path: "missing.txt",
          label: "the file",
          reason: "absent",
        },
      ],
    });
  });

  it("probes a path prerequisite exactly once (backend-independent)", async () => {
    const { probes, calls } = makeCountingProbes({
      path: () => ({ satisfied: false, reason: "absent" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    await service.evaluate({
      definition: definitionWith([{ kind: "path", path: "x" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(calls.filter((c) => c.kind === "path")).toHaveLength(1);
  });

  it("distinguishes a probe_error miss from absent (fail closed)", async () => {
    const { probes } = makeCountingProbes({
      path: () => ({ satisfied: false, reason: "probe_error" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([{ kind: "path", path: "x" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude"]),
    });

    expect(result).toEqual({
      status: "prerequisites_unmet",
      missing: [
        { kind: "path", path: "x", label: null, reason: "probe_error" },
      ],
    });
  });

  it("checks a backend-scoped skill ONLY on its declared backend", async () => {
    const { probes, calls } = makeCountingProbes({
      skill: () => ({ satisfied: true }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    await service.evaluate({
      definition: definitionWith([
        { kind: "skill", skill: "scoped", backend: "codex" },
      ]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    const skillCalls = calls.filter((c) => c.kind === "skill");
    expect(skillCalls).toEqual([
      { kind: "skill", skill: "scoped", backend: "codex" },
    ]);
  });

  it("reports a backend-scoped skill miss naming its scoped backend", async () => {
    const { probes } = makeCountingProbes({
      skill: () => ({ satisfied: false, reason: "absent" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([
        { kind: "skill", skill: "scoped", backend: "codex", label: "L" },
      ]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(result).toEqual({
      status: "prerequisites_unmet",
      missing: [
        {
          kind: "skill",
          skill: "scoped",
          backend: "codex",
          label: "L",
          reason: "absent",
        },
      ],
    });
  });

  it("checks a backend-unscoped skill on EVERY used backend", async () => {
    const { probes, calls } = makeCountingProbes({
      skill: () => ({ satisfied: true }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    await service.evaluate({
      definition: definitionWith([{ kind: "skill", skill: "shared" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    const backendsProbed = calls
      .filter((c) => c.kind === "skill")
      .map((c) => c.backend)
      .sort();
    expect(backendsProbed).toEqual(["claude", "codex"]);
  });

  it("reports a backend-unscoped skill unmet when missing on ONE used backend (multi-backend false-pass)", async () => {
    const { probes } = makeCountingProbes({
      skill: ({ backend }) =>
        backend === "codex"
          ? { satisfied: false, reason: "absent" }
          : { satisfied: true },
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([{ kind: "skill", skill: "shared" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(result).toEqual({
      status: "prerequisites_unmet",
      missing: [
        {
          kind: "skill",
          skill: "shared",
          backend: null,
          label: null,
          reason: "absent",
        },
      ],
    });
  });

  it("emits ONE aggregated miss for a backend-unscoped skill unmet on multiple backends", async () => {
    const { probes } = makeCountingProbes({
      skill: () => ({ satisfied: false, reason: "absent" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([{ kind: "skill", skill: "shared" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(result.status).toBe("prerequisites_unmet");
    if (result.status === "prerequisites_unmet") {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toMatchObject({
        kind: "skill",
        skill: "shared",
        backend: null,
      });
    }
  });

  it("fails closed as probe_error when any used backend errors for a backend-unscoped skill", async () => {
    const { probes } = makeCountingProbes({
      skill: ({ backend }) =>
        backend === "codex"
          ? { satisfied: false, reason: "probe_error" }
          : { satisfied: false, reason: "absent" },
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([{ kind: "skill", skill: "shared" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude", "codex"]),
    });

    expect(result).toEqual({
      status: "prerequisites_unmet",
      missing: [
        {
          kind: "skill",
          skill: "shared",
          backend: null,
          label: null,
          reason: "probe_error",
        },
      ],
    });
  });

  it("treats a backend-unscoped skill with an empty used-backend set as unmet (no backend to satisfy on)", async () => {
    const { probes, calls } = makeCountingProbes({});
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([{ kind: "skill", skill: "shared" }]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(),
    });

    expect(result.status).toBe("prerequisites_unmet");
    if (result.status === "prerequisites_unmet") {
      expect(result.missing).toEqual([
        {
          kind: "skill",
          skill: "shared",
          backend: null,
          label: null,
          reason: "absent",
        },
      ]);
    }
    expect(calls).toHaveLength(0);
  });

  it("collects ALL misses without short-circuiting, in declaration order", async () => {
    const { probes } = makeCountingProbes({
      path: () => ({ satisfied: false, reason: "absent" }),
      skill: () => ({ satisfied: false, reason: "absent" }),
    });
    const service = createPreflightPrerequisiteService({ probes });

    const result = await service.evaluate({
      definition: definitionWith([
        { kind: "skill", skill: "first", backend: "claude" },
        { kind: "path", path: "second.txt" },
        { kind: "skill", skill: "third" },
      ]),
      worktreePath: WORKTREE,
      usedBackends: new Set<AgentBackendId>(["claude"]),
    });

    expect(result.status).toBe("prerequisites_unmet");
    if (result.status === "prerequisites_unmet") {
      expect(
        result.missing.map((m) => (m.kind === "path" ? m.path : m.skill)),
      ).toEqual(["first", "second.txt", "third"]);
    }
  });

  it("defaults to the real probes when none are injected", () => {
    const service = createPreflightPrerequisiteService();
    expect(typeof service.evaluate).toBe("function");
  });
});
