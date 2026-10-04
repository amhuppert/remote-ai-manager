import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextProgress,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import { decideNext, deriveRunProgress, type ObservedContexts } from "./schedule";
import type { RunFacts } from "./schemas";

const seat = {
  profile: { tier: "builtin" as const, id: "standard-agent" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function request(key: string): ContextStartRequest {
  return {
    contextId: `run-1.${key}`,
    runId: "run-1",
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract: contextContractSchema.parse({
      title: `Title ${key}`,
      brief: `Brief ${key}`,
      tasks: [],
      acceptanceCriteria: [],
      outputSchema: null,
      allowTaskAddition: true,
      implementer: { id: "implementer", ...seat },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
      documents: [],
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  };
}

/** api and ui are roots; integrate depends on both. */
function facts(
  started: string[],
  control: RunFacts["control"] = { paused: false, cancelled: false, fault: null },
): RunFacts {
  return {
    runId: "run-1",
    kind: "workflow",
    title: "Two writers and an integration",
    definition: {
      revision: 1,
      contexts: [
        { key: "api", dependsOn: [], request: request("api") },
        { key: "ui", dependsOn: [], request: request("ui") },
        { key: "integrate", dependsOn: ["api", "ui"], request: request("integrate") },
      ],
    },
    invocations: started.map((key) => ({
      key,
      pass: 0,
      contextId: `run-1.${key}`,
      startCause: `run-1:start:${key}:0`,
      request: request(key),
    })),
    control,
  };
}

const running: ContextProgress = {
  kind: "running",
  obligation: { kind: "work", reason: "initial" },
};
const succeeded = (candidateId: string): ContextProgress => ({
  kind: "succeeded",
  candidateId,
});
const halted: ContextProgress = {
  kind: "halted",
  halt: "turn_failed",
  detail: "The provider failed.",
};

function observed(
  entries: Record<string, { progress: ContextProgress | null; output?: unknown; active?: boolean }>,
): ObservedContexts {
  return new Map(
    Object.entries(entries).map(([key, entry]) => [key, { active: false, ...entry }]),
  );
}

describe("scheduler", () => {
  it("starts every context without dependencies at launch", () => {
    expect(decideNext(facts([]), observed({})).map((s) => s.key)).toEqual(["api", "ui"]);
  });

  it("starts a context once all its dependencies succeeded, with their accepted outputs as inputs", () => {
    const partly = observed({
      api: { progress: succeeded("c-api"), output: { endpoint: "/v1/x" } },
      ui: { progress: running },
    });
    expect(decideNext(facts(["api", "ui"]), partly)).toEqual([]);

    const both = observed({
      api: { progress: succeeded("c-api"), output: { endpoint: "/v1/x" } },
      ui: { progress: succeeded("c-ui"), output: { summary: "Built the page." } },
    });
    expect(decideNext(facts(["api", "ui"]), both)).toEqual([
      {
        key: "integrate",
        inputs: [
          { key: "api", title: "Title api", output: { endpoint: "/v1/x" } },
          { key: "ui", title: "Title ui", output: { summary: "Built the page." } },
        ],
      },
    ]);
  });

  it("starts nothing new while paused or cancelled, and never starts a context twice", () => {
    const done = observed({
      api: { progress: succeeded("c-api"), output: null },
      ui: { progress: succeeded("c-ui"), output: null },
    });
    expect(decideNext(facts(["api", "ui"], { paused: true, cancelled: false, fault: null }), done)).toEqual([]);
    expect(decideNext(facts(["api", "ui"], { paused: false, cancelled: true, fault: null }), done)).toEqual([]);
    expect(decideNext(facts(["api", "ui", "integrate"]), done)).toEqual([]);
  });
});

describe("run progress", () => {
  const question: ContextProgress = {
    kind: "waiting",
    obligation: { kind: "await_answer", questionId: "q-1" },
  };

  it("succeeds only when every defined context succeeded, not every started one", () => {
    const roots = observed({
      api: { progress: succeeded("c-api") },
      ui: { progress: succeeded("c-ui") },
    });
    expect(deriveRunProgress(facts(["api", "ui"]), roots)).toEqual({ kind: "running" });

    const all = observed({
      api: { progress: succeeded("c-api") },
      ui: { progress: succeeded("c-ui") },
      integrate: { progress: succeeded("c-int") },
    });
    expect(deriveRunProgress(facts(["api", "ui", "integrate"]), all)).toEqual({
      kind: "succeeded",
    });
  });

  it("needs the owner only once no other context can make progress", () => {
    expect(
      deriveRunProgress(facts(["api", "ui"]), observed({ api: { progress: question }, ui: { progress: running } })),
    ).toEqual({ kind: "running" });
    // integrate waits on api, so nothing else can move.
    expect(
      deriveRunProgress(
        facts(["api", "ui"]),
        observed({ api: { progress: halted }, ui: { progress: succeeded("c-ui") } }),
      ),
    ).toEqual({ kind: "needs_owner", reasons: ["api: halted (turn_failed)"] });
  });

  it("reports a paused run as draining while a started context's admitted effect still runs", () => {
    const paused = { paused: true, cancelled: false, fault: null };
    expect(
      deriveRunProgress(
        facts(["api", "ui"], paused),
        observed({ api: { progress: running, active: true }, ui: { progress: running } }),
      ),
    ).toEqual({ kind: "paused", draining: true });
    expect(
      deriveRunProgress(facts(["api", "ui"], paused), observed({ api: { progress: running }, ui: { progress: running } })),
    ).toEqual({ kind: "paused", draining: false });
  });

  it("needs the owner while the run itself faulted, and starts nothing until then", () => {
    const faulted = { paused: false, cancelled: false, fault: { detail: "The definition could not be read", at: "t" } };
    const roots = observed({
      api: { progress: succeeded("c-api"), output: null },
      ui: { progress: succeeded("c-ui"), output: null },
    });
    expect(decideNext(facts(["api", "ui"], faulted), roots)).toEqual([]);
    expect(deriveRunProgress(facts(["api", "ui"], faulted), roots)).toEqual({
      kind: "needs_owner",
      reasons: ["run: The definition could not be read"],
    });
  });

  it("counts a started context its host has not created yet as work in progress", () => {
    expect(
      deriveRunProgress(
        facts(["api", "ui"]),
        observed({ api: { progress: question }, ui: { progress: null } }),
      ),
    ).toEqual({ kind: "running" });
  });

  it("is cancelled once every started context stopped, whatever never started", () => {
    const cancelled: ContextProgress = { kind: "cancelled" };
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: running } }),
      ),
    ).toEqual({ kind: "stopping" });
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: succeeded("c-ui") } }),
      ),
    ).toEqual({ kind: "cancelled" });
    // A start no Context took up before the permit was revoked never will be.
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: null } }),
      ),
    ).toEqual({ kind: "cancelled" });
  });
});
