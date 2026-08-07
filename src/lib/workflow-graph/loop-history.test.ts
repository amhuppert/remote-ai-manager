/**
 * Loop History injection (D4 R16.1).
 *
 * The bounded, ENTRY-ONLY prompt section a pass entry receives: what the prior
 * passes' body contexts produced, and how each of those passes was decided. The
 * suite drives real passes through `runPass` so the history is derived from the
 * same blob markers and pass-instance captures production reads — a hand-built
 * ledger would prove nothing about what an entry prompt actually says.
 */

import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { buildIterationPrompt } from "./iteration-prompt";
import {
  LOOP_HISTORY_MAX_CONTEXT_BYTES,
  LOOP_HISTORY_MAX_PASSES,
  LOOP_HISTORY_MAX_SECTION_BYTES,
  renderLoopHistorySection,
  resolveLoopHistory,
} from "./loop-history";
import { loopInstanceId } from "./loop-resolver";
import {
  JUDGE_OUTPUT_SCHEMA,
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  P3_WORKER,
  UNTIL_PASS,
  completeContext,
  context,
  edge,
  executionFor,
  runPass,
  task,
  workerJudgeDefinition,
} from "./loop-test-fixtures";

const WORKER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { draft: { type: "string" }, handoff: { type: "string" } },
  required: ["draft"],
  additionalProperties: false,
};

/**
 * The worker declares a schema too, which is the documented handoff-field
 * convention: free-form inter-pass narrative rides a body context's own
 * structured output rather than a loop-scoped store.
 */
function historyDefinition(maxPasses = 3) {
  return workerJudgeDefinition(
    {
      executionContexts: [
        context("seed", { outputSchema: undefined }),
        context("worker", { outputSchema: WORKER_OUTPUT_SCHEMA }),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
    },
    { maxPasses },
  );
}

/** Drive one full failing pass so the next pass is materialized. */
function failPass(
  execution: GraphWorkflowExecution,
  pass: number,
  worker: Record<string, unknown> = { draft: `draft ${pass}` },
): GraphWorkflowExecution {
  completeContext(execution, loopInstanceId("refine", pass, "worker"), worker);
  completeContext(execution, loopInstanceId("refine", pass, "judge"), {
    verdict: "fail",
    notes: `pass ${pass} needs work`,
  });
  return runPass(execution).execution;
}

function startedLoopFor(
  definition: ReturnType<typeof workerJudgeDefinition>,
): GraphWorkflowExecution {
  const execution = executionFor(definition);
  completeContext(execution, "seed");
  return runPass(execution).execution;
}

function startedLoop(maxPasses = 3): GraphWorkflowExecution {
  return startedLoopFor(historyDefinition(maxPasses));
}

/**
 * A single-entry/single-exit body wide enough that ONE pass can exceed the
 * section bound — `bodySize` contexts chained worker → … → judge, optionally
 * with long titles so the context HEADERS alone can blow the budget.
 */
function wideBodyLoop(options: {
  bodySize: number;
  titleLength?: number;
  maxPasses?: number;
}): {
  definition: ReturnType<typeof workerJudgeDefinition>;
  bodyIds: string[];
} {
  const { bodySize, titleLength = 0, maxPasses = 4 } = options;
  const middle = Array.from(
    { length: bodySize - 2 },
    (_, index) => `body${index + 1}`,
  );
  const bodyIds = ["worker", ...middle, "judge"];
  const titled = (id: string) =>
    titleLength > 0 ? `${id} ${"t".repeat(titleLength)}` : id;
  const chain = ["seed", ...bodyIds, "publish"];

  const definition = workerJudgeDefinition({
    executionContexts: [
      context("seed", { outputSchema: undefined }),
      ...bodyIds.map((id) =>
        context(id, {
          title: titled(id),
          outputSchema:
            id === "judge" ? JUDGE_OUTPUT_SCHEMA : WORKER_OUTPUT_SCHEMA,
        }),
      ),
      context("publish"),
    ],
    tasks: chain.map((id) => task(`task-${id}`, id)),
    edges: chain.slice(0, -1).map((source, index) => {
      const target = chain[index + 1] ?? "";
      return edge(`${source}__${target}`, source, target);
    }),
    loopGroups: [
      {
        id: "refine",
        bodyContextIds: bodyIds,
        entryContextId: "worker",
        exitContextId: "judge",
        until: UNTIL_PASS,
        maxPasses,
      },
    ],
  });
  return { definition, bodyIds };
}

/** Fail one pass of a wide body, each context banking an oversized capture. */
function failWidePass(
  execution: GraphWorkflowExecution,
  pass: number,
  bodyIds: readonly string[],
): GraphWorkflowExecution {
  const oversized = "x".repeat(LOOP_HISTORY_MAX_CONTEXT_BYTES * 2);
  for (const bodyId of bodyIds) {
    completeContext(
      execution,
      loopInstanceId("refine", pass, bodyId),
      bodyId === "judge"
        ? { verdict: "fail", notes: oversized }
        : { draft: oversized },
    );
  }
  return runPass(execution).execution;
}

function promptFor(
  execution: GraphWorkflowExecution,
  contextId: string,
): string {
  const definitionContext = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!definitionContext) throw new Error(`no context "${contextId}"`);
  return buildIterationPrompt({
    context: definitionContext,
    tasks: execution.workingDefinition.tasks.filter(
      (entry) => entry.contextId === contextId,
    ),
    taskStates: execution.taskStates,
    sharedDocuments: [],
    allowAgentTaskAdd: false,
    validationSelections: {
      registry: "none",
      enabled: { kind: "commands", commands: [] },
      disabled: [],
      scriptGate: { kind: "off" },
    },
    loopHistory: resolveLoopHistory(execution, contextId),
  });
}

describe("Loop History is entry-only (R16.1)", () => {
  it("gives pass k+1's entry the prior pass's captures, verdict and outcome", () => {
    let execution = startedLoop();
    execution = failPass(execution, 1, {
      draft: "first attempt",
      handoff: "the sorting helper is the weak spot",
    });

    const history = resolveLoopHistory(execution, P2_WORKER);
    expect(history).not.toBeNull();
    expect(history?.loopGroupId).toBe("refine");
    expect(history?.pass).toBe(2);
    expect(history?.passes.map((entry) => entry.pass)).toEqual([1]);

    const priorPass = history?.passes[0];
    expect(priorPass?.contexts.map((entry) => entry.contextId)).toEqual([
      P1_WORKER,
      P1_JUDGE,
    ]);
    expect(priorPass?.decision?.verdict).toBe("unsatisfied");
    expect(priorPass?.decision?.outcome).toBe("materialized");
    expect(priorPass?.decision?.loopControlRevision).toBe(0);

    const prompt = promptFor(execution, P2_WORKER);
    expect(prompt).toContain("## Loop History");
    expect(prompt).toContain("the sorting helper is the weak spot");
    expect(prompt).toContain("pass 1 needs work");
    expect(prompt).toContain("unsatisfied");
    expect(prompt).toContain("materialized");
    expect(prompt).toContain("loopControlRevision 0");
  });

  it("gives a same-pass body context no history section at all", () => {
    let execution = startedLoop();
    execution = failPass(execution, 1);

    expect(resolveLoopHistory(execution, P2_JUDGE)).toBeNull();
    expect(promptFor(execution, P2_JUDGE)).not.toContain("## Loop History");

    // Pass 1's entry has no prior pass, so it gets nothing either.
    expect(resolveLoopHistory(execution, P1_WORKER)).toBeNull();
    expect(promptFor(execution, P1_WORKER)).not.toContain("## Loop History");
  });

  it("gives a context outside every loop no history section", () => {
    let execution = startedLoop();
    execution = failPass(execution, 1);

    expect(resolveLoopHistory(execution, "publish")).toBeNull();
    expect(resolveLoopHistory(execution, "seed")).toBeNull();
  });
});

describe("Loop History honours its bounds (R16.1)", () => {
  it("keeps only the most recent N passes and says how many it dropped", () => {
    let execution = startedLoop(8);
    for (let pass = 1; pass <= 4; pass += 1) {
      execution = failPass(execution, pass);
    }

    const history = resolveLoopHistory(
      execution,
      loopInstanceId("refine", 5, "worker"),
    );
    expect(history?.passes).toHaveLength(LOOP_HISTORY_MAX_PASSES);
    expect(history?.passes.map((entry) => entry.pass)).toEqual([2, 3, 4]);
    expect(history?.omittedPassCount).toBe(1);

    const prompt = promptFor(execution, loopInstanceId("refine", 5, "worker"));
    expect(prompt).toContain("## Loop History");
    expect(prompt).not.toContain("draft 1");
    expect(prompt).toContain("draft 4");
  });

  it("truncates an oversized capture per context and caps the whole section", () => {
    let execution = startedLoop(8);
    // Each pass carries a capture far past the per-context budget, so both the
    // per-context truncation and the section cap have to bite.
    for (let pass = 1; pass <= 3; pass += 1) {
      execution = failPass(execution, pass, {
        draft: "x".repeat(LOOP_HISTORY_MAX_CONTEXT_BYTES * 4),
        handoff: `pass ${pass}`,
      });
    }

    const entryId = loopInstanceId("refine", 4, "worker");
    const history = resolveLoopHistory(execution, entryId);
    const workerEntry = history?.passes
      .flatMap((pass) => pass.contexts)
      .find((entry) => entry.contextId === P3_WORKER);
    expect(workerEntry?.truncated).toBe(true);
    expect(workerEntry?.output?.length).toBeLessThanOrEqual(
      LOOP_HISTORY_MAX_CONTEXT_BYTES,
    );

    const prompt = promptFor(execution, entryId);
    const section = prompt.slice(prompt.indexOf("## Loop History"));
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(
      LOOP_HISTORY_MAX_SECTION_BYTES,
    );
  });

  it("degrades a single oversized pass instead of dropping the section", () => {
    // Nine body contexts, each banking a capture past the per-context bound: the
    // newest prior pass alone exceeds the section budget. Bounded degradation is
    // the requirement — pass k+1 must still be told how pass k was decided.
    const loop = wideBodyLoop({ bodySize: 9 });
    let execution = startedLoopFor(loop.definition);
    execution = failWidePass(execution, 1, loop.bodyIds);

    const entryId = loopInstanceId("refine", 2, "worker");
    const history = resolveLoopHistory(execution, entryId);
    expect(history?.passes.map((entry) => entry.pass)).toEqual([1]);
    expect(history?.omittedPassCount).toBe(0);

    const priorPass = history?.passes[0];
    expect(priorPass?.decision?.verdict).toBe("unsatisfied");
    expect(priorPass?.decision?.outcome).toBe("materialized");
    expect(priorPass?.decision?.loopControlRevision).toBe(0);

    const section = renderLoopHistorySection(history ?? null);
    expect(section).not.toBeNull();
    expect(Buffer.byteLength(section ?? "", "utf8")).toBeLessThanOrEqual(
      LOOP_HISTORY_MAX_SECTION_BYTES,
    );
    expect(section).toContain("unsatisfied → materialized");
    expect(section).toContain("loopControlRevision 0");
    // Every body context is still named, and each payload that could not be
    // carried in full says so rather than vanishing silently.
    for (const bodyId of loop.bodyIds) {
      expect(section).toContain(bodyId);
    }
    expect(
      priorPass?.contexts.some(
        (entry) => entry.truncated || entry.outputOmitted,
      ),
    ).toBe(true);

    const prompt = promptFor(execution, entryId);
    expect(prompt).toContain("## Loop History");
    expect(prompt).toContain("loopControlRevision 0");
  });

  it("keeps the newest pass's decision readable when even its headers do not fit", () => {
    // Oversized captures are not the only way to blow the budget: a body whose
    // CONTEXT HEADERS alone exceed the cap must still report the decision, so
    // the degradation ladder's last rung is a decision-only block.
    const loop = wideBodyLoop({ bodySize: 40, titleLength: 600 });
    let execution = startedLoopFor(loop.definition);
    execution = failWidePass(execution, 1, loop.bodyIds);

    const history = resolveLoopHistory(
      execution,
      loopInstanceId("refine", 2, "worker"),
    );
    const section = renderLoopHistorySection(history ?? null);
    expect(section).not.toBeNull();
    expect(Buffer.byteLength(section ?? "", "utf8")).toBeLessThanOrEqual(
      LOOP_HISTORY_MAX_SECTION_BYTES,
    );
    expect(section).toContain("unsatisfied → materialized");
  });
});
