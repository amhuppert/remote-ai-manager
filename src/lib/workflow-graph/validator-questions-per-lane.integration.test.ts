/**
 * R9.1: several validators of one cohort waiting on the human at once.
 *
 * Driven through the REAL engine — the orchestrator's round, the production
 * validation service, the real user-input gate, and the real manager's pause —
 * with a fake at the single-specialist dispatch boundary only. What a test here
 * proves about concurrency, routing, and cancellation therefore holds of the
 * production path rather than of a re-implementation of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";
import type { ValidationCandidateTreeResolution } from "@/lib/workflow-graph/validation-round";
import {
  createUserInputGateService,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import {
  createCohortExecution,
  createHarness,
  metadata,
  passResult,
  specialistRecord,
  withOpenRound,
  type Harness,
  NOW,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";

const CONTEXT_ID = "context-plan";
const SECURITY = "security-reviewer";
const PERF = "perf-reviewer";
const SECURITY_KEY = laneStateKey("context_validator", SECURITY);
const PERF_KEY = laneStateKey("context_validator", PERF);
const SECURITY_CONVERSATION = "conversation-security-reviewer";
const PERF_CONVERSATION = "conversation-perf-reviewer";

const QUESTIONS = [
  {
    id: "q-1",
    question: "Is the legacy token path in scope?",
    options: [
      { label: "Yes", recommended: false },
      { label: "No", recommended: false },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

function answers(selected: string): Record<string, AskQuestionAnswer> {
  return {
    "q-1": {
      selected: [selected],
      note: null,
      skipped: false,
      question: QUESTIONS[0]!.question,
    },
  };
}

function skippedAnswers(): Record<string, AskQuestionAnswer> {
  return {
    "q-1": {
      selected: [],
      note: null,
      skipped: true,
      question: QUESTIONS[0]!.question,
    },
  };
}

/** Lane states for the cohort, each validator holding its own conversation. */
function withLaneStates(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  const next = structuredClone(execution);
  next.laneStates = {
    [CONTEXT_ID]: {
      [SECURITY_KEY]: {
        lane: "context_validator",
        contextId: CONTEXT_ID,
        backend: "claude",
        refKind: "conversation",
        workflowConversationId: SECURITY_CONVERSATION,
        sessionRef: { backend: "claude", ref: SECURITY_CONVERSATION },
        metrics: { rotateBeforeNextTurn: false },
        limitEvaluation: "disabled",
        lastUsedAt: NOW,
      },
      [PERF_KEY]: {
        lane: "context_validator",
        contextId: CONTEXT_ID,
        backend: "claude",
        refKind: "conversation",
        workflowConversationId: PERF_CONVERSATION,
        sessionRef: { backend: "claude", ref: PERF_CONVERSATION },
        metrics: { rotateBeforeNextTurn: false },
        limitEvaluation: "disabled",
        lastUsedAt: NOW,
      },
    },
  };
  return next;
}

describe("R9.1 — per-lane parked questions across a cohort", () => {
  let cleared: string[];
  let broadcasts: GraphWorkflowExecutionEvent["event"][];

  beforeEach(() => {
    cleared = [];
    broadcasts = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The harness plus a real gate over its repository. Both validators ask while
   * `asking` is true; every other lane passes.
   */
  function buildAskingCohort(options: {
    asking: () => boolean;
    resolveCandidateTree?: () => ValidationCandidateTreeResolution;
    execution?: GraphWorkflowExecution;
    /**
     * Runs inside a lane's dispatch, before it reports. The only place a test
     * can land an answer while a sibling lane is genuinely mid-review.
     */
    onDispatch?: (assignmentId: string) => Promise<void>;
    /** Which seats ask while `asking` holds; both askers by default. */
    askers?: readonly string[];
  }) {
    const calls: string[] = [];
    const received: Record<string, Record<string, AskQuestionAnswer> | null> =
      {};
    // The harness is built over the gate and the gate over the harness's
    // repository, so each is held in a box the other reads through lazily.
    const built: {
      harness: Harness | null;
      gate: UserInputGateService | null;
    } = { harness: null, gate: null };

    function builtHarness(): Harness {
      if (!built.harness) throw new Error("harness read before it was built");
      return built.harness;
    }

    function builtGate(): UserInputGateService {
      if (!built.gate) throw new Error("gate read before it was built");
      return built.gate;
    }

    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: (event) => {
        broadcasts.push(event);
      },
      now: () => NOW,
    });

    const lazyGate: UserInputGateService = {
      resolveLaneAskPermission: (...args) =>
        builtGate().resolveLaneAskPermission(...args),
      enterAwaitingUserInput: (input) =>
        builtGate().enterAwaitingUserInput(input),
      recordAnswers: (input) => builtGate().recordAnswers(input),
      consumeAnswers: (input) => builtGate().consumeAnswers(input),
      withdrawAll: (input) => builtGate().withdrawAll(input),
      withdrawRoundQuestions: (input) =>
        builtGate().withdrawRoundQuestions(input),
    };

    built.harness = createHarness({
      execution: withLaneStates(options.execution ?? createCohortExecution()),
      ...(options.resolveCandidateTree
        ? { resolveCandidateTree: options.resolveCandidateTree }
        : {}),
      userInputGateService: lazyGate,
      runContextValidator: async (input): Promise<ValidatorRunResult> => {
        calls.push(input.validator.id);
        received[input.validator.id] = input.resumeUserInput?.answers ?? null;
        await options.onDispatch?.(input.validator.id);
        const isAsker =
          (input.validator.id === SECURITY || input.validator.id === PERF) &&
          (options.askers?.includes(input.validator.id) ?? true);
        if (isAsker && options.asking()) {
          return {
            result: {
              kind: "asked_user",
              conversationId: `conversation-${input.validator.id}`,
              questionBatchId: `batch-${input.validator.id}`,
              questions: QUESTIONS,
            },
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    built.harness.repository.deliver = publisher.deliver;

    built.gate = createUserInputGateService({
      getActive: async () => builtHarness().repository.read(),
      mutateActive: (projectPath, sessionName, fn) =>
        builtHarness().repository.mutateActive(projectPath, sessionName, fn),
      publishUserInputPending: publisher.publishUserInputPending,
      publishUserInputResolved: publisher.publishUserInputResolved,
      deliver: publisher.deliver,
      clearConversationQuestion: async (
        _projectPath,
        _sessionName,
        conversationId,
      ) => {
        cleared.push(conversationId);
        return true;
      },
      now: () => NOW,
    });

    return { harness: builtHarness(), gate: builtGate(), calls, received };
  }

  /** What the loop does between the park and the resume. */
  async function consume(gate: UserInputGateService) {
    return await gate.consumeAnswers({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_ID,
    });
  }

  async function answer(
    gate: UserInputGateService,
    assignmentId: string,
    payload: Record<string, AskQuestionAnswer> = answers("Yes"),
  ) {
    return await gate.recordAnswers({
      projectPath: "/repo",
      sessionName: "session-1",
      conversationId: `conversation-${assignmentId}`,
      questionBatchId: `batch-${assignmentId}`,
      answers: payload,
    });
  }

  it("parks both asking validators at once, each on its own round-scoped record", async () => {
    const { harness } = buildAskingCohort({ asking: () => true });

    await harness.run();

    const contextState = harness.contextState()!;
    expect(Object.keys(contextState.pendingUserInputs).sort()).toEqual(
      [PERF_KEY, SECURITY_KEY].sort(),
    );
    const roundSeq = contextState.validationRound?.seq;
    for (const key of [SECURITY_KEY, PERF_KEY]) {
      expect(contextState.pendingUserInputs[key]).toMatchObject({
        roundSeq,
        answers: null,
      });
    }
    expect(contextState.status).toBe("awaiting_user_input");
    // A parked lane is an unsettled outcome: the round stays open around the
    // wait, holding the sibling's verdict rather than concluding on it.
    expect(contextState.validationRound?.phase).toBe("specialists");
    expect(contextState.validationRound?.specialists["general"]?.state).toBe(
      "verdict_pass",
    );
    for (const id of [SECURITY, PERF]) {
      expect(contextState.validationRound?.specialists[id]).toMatchObject({
        state: "parked",
        questionToken: `batch-${id}`,
      });
    }
    // Neither park is a verdict, so nothing is charged and nothing published.
    expect(harness.results()).toHaveLength(0);
  });

  it("both questions reach the operator: one pending record per asking lane, each on its own conversation", async () => {
    const { harness } = buildAskingCohort({ asking: () => true });

    await harness.run();

    const parked = harness.contextState()!.pendingUserInputs;
    expect(parked[SECURITY_KEY]?.conversationId).toBe(SECURITY_CONVERSATION);
    expect(parked[PERF_KEY]?.conversationId).toBe(PERF_CONVERSATION);
    // Two distinct conversations hold two distinct question batches — the two
    // attention entries the operator sees are not one entry with two questions.
    expect(parked[SECURITY_KEY]?.questionBatchId).not.toBe(
      parked[PERF_KEY]?.questionBatchId,
    );
    expect(
      broadcasts.filter(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toHaveLength(2);
  });

  it("answering one settles that lane while the sibling stays parked, and the round concludes only after both settle", async () => {
    let asking = true;
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => asking,
    });
    await harness.run();
    const parkedBefore = harness.contextState()!.pendingUserInputs[PERF_KEY]!;

    // Only ONE lane is answered, and it resumes on that answer alone — waiting
    // for the sibling would make the slowest question the pace of the cohort.
    expect(await answer(gate, SECURITY)).toEqual({ ok: true });
    let contextState = harness.contextState()!;
    expect(
      contextState.pendingUserInputs[SECURITY_KEY]?.answers?.byQuestionId,
    ).toEqual(answers("Yes"));
    expect(contextState.pendingUserInputs[PERF_KEY]?.answers).toBeNull();
    expect(contextState.status).toBe("awaiting_user_input");
    expect(contextState.validationRound?.phase).toBe("specialists");

    const consumed = await consume(gate);
    expect(consumed.map((entry) => entry.laneKey)).toEqual([SECURITY_KEY]);
    asking = false;
    calls.length = 0;

    await harness.run({ resumeUserInputs: consumed });

    // The answered lane re-reviewed with its answers; `general`'s verdict was
    // retained; the parked lane was NOT re-dispatched — re-running it would
    // have replaced the question the human is still looking at.
    expect(calls).toEqual([SECURITY]);
    expect(received[SECURITY]).toEqual(answers("Yes"));

    contextState = harness.contextState()!;
    expect(contextState.pendingUserInputs[PERF_KEY]).toEqual(parkedBefore);
    expect(contextState.status).toBe("awaiting_user_input");
    // The round stays open around the wait, now holding two verdicts.
    expect(contextState.validationRound?.phase).toBe("specialists");
    expect(contextState.validationRound?.specialists[SECURITY]?.state).toBe(
      "verdict_pass",
    );
    expect(contextState.validationRound?.specialists[PERF]?.state).toBe(
      "parked",
    );
    expect(harness.results()).toHaveLength(0);
    // The standing question is asserted once, not re-published to the operator.
    expect(
      broadcasts.filter(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toHaveLength(2);

    // The sibling's answer then settles the round on its own.
    expect(await answer(gate, PERF)).toEqual({ ok: true });
    const secondConsumed = await consume(gate);
    expect(secondConsumed.map((entry) => entry.laneKey)).toEqual([PERF_KEY]);
    calls.length = 0;

    await harness.run({ resumeUserInputs: secondConsumed });

    expect(calls).toEqual([PERF]);
    expect(harness.contextState()!.validationRound?.phase).toBe("concluded");
    expect(harness.contextState()!.validationRound?.outcome).toBe("passed");
    expect(harness.results()).toHaveLength(1);
  });

  it("delivers near-simultaneous answers to their own lane exactly once", async () => {
    let asking = true;
    const { harness, gate, received } = buildAskingCohort({
      asking: () => asking,
    });
    await harness.run();

    // Both answers land back-to-back, as two operators (or two clicks) would.
    await Promise.all([
      answer(gate, SECURITY, answers("Yes")),
      answer(gate, PERF, answers("No")),
    ]);
    asking = false;
    const consumed = await consume(gate);
    for (const key of Object.keys(received)) delete received[key];

    await harness.run({ resumeUserInputs: consumed });

    expect(received[SECURITY]).toEqual(answers("Yes"));
    expect(received[PERF]).toEqual(answers("No"));
    // `general` never asked, so it is neither re-run nor handed anyone's reply.
    expect(received["general"]).toBeUndefined();
    // The records are gone: an answer cannot be delivered a second time.
    expect(harness.contextState()!.pendingUserInputs).toEqual({});
    expect(await answer(gate, SECURITY)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("delivers a sibling's answer that lands DURING a partial resume, exactly once", async () => {
    let asking = true;
    let partialResume = false;
    let siblingAnswered = false;
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => asking,
      onDispatch: async (assignmentId) => {
        // The operator answers the still-parked sibling while the resumed lane
        // is mid-review. Partial resume is what opens this window: the round
        // has already snapshotted `perf` as parked for this pass, so its answer
        // arrives against a lane nothing is about to dispatch.
        if (!partialResume || assignmentId !== SECURITY || siblingAnswered) {
          return;
        }
        siblingAnswered = true;
        expect(await answer(gate, PERF, answers("No"))).toEqual({ ok: true });
      },
    });
    await harness.run();

    expect(await answer(gate, SECURITY, answers("Yes"))).toEqual({ ok: true });
    const consumed = await consume(gate);
    expect(consumed.map((entry) => entry.laneKey)).toEqual([SECURITY_KEY]);
    asking = false;
    partialResume = true;
    calls.length = 0;

    await harness.run({ resumeUserInputs: consumed });

    expect(siblingAnswered).toBe(true);
    // The sibling's answer is neither delivered by this pass (its lane was
    // carried forward untouched) nor lost to it: the lane still owes a review,
    // so the round stays open around the answered record and the context stays
    // parked rather than completing over a lane that never reported.
    let contextState = harness.contextState()!;
    expect(contextState.status).toBe("awaiting_user_input");
    expect(
      contextState.pendingUserInputs[PERF_KEY]?.answers?.byQuestionId,
    ).toEqual(answers("No"));
    expect(contextState.validationRound?.phase).toBe("specialists");
    expect(contextState.validationRound?.specialists[SECURITY]?.state).toBe(
      "verdict_pass",
    );
    expect(contextState.validationRound?.specialists[PERF]?.state).toBe(
      "parked",
    );
    expect(harness.results()).toHaveLength(0);

    // The next pass delivers it — to the lane that asked, in the round that
    // asked it, and only then does the round conclude.
    const secondConsumed = await consume(gate);
    expect(secondConsumed.map((entry) => entry.laneKey)).toEqual([PERF_KEY]);
    calls.length = 0;

    await harness.run({ resumeUserInputs: secondConsumed });

    expect(calls).toEqual([PERF]);
    expect(received[PERF]).toEqual(answers("No"));
    expect(received[SECURITY]).toEqual(answers("Yes"));
    contextState = harness.contextState()!;
    expect(contextState.pendingUserInputs).toEqual({});
    expect(contextState.validationRound?.phase).toBe("concluded");
    expect(contextState.validationRound?.outcome).toBe("passed");
    // Exactly once: neither answer can be redelivered, and the cohort that
    // reviewed this candidate published one aggregate.
    expect(await answer(gate, PERF)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(harness.results()).toHaveLength(1);
  });

  it("holds the round open for an answer that beat the cohort's park write", async () => {
    let asking = true;
    let answered = false;
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => asking,
      askers: [SECURITY],
      onDispatch: async (assignmentId) => {
        // `security` asked and its turn is over; `perf` is still reviewing. The
        // park write happens only once the whole cohort settles, so this window
        // is as long as the slowest sibling takes — not a millisecond race.
        if (assignmentId !== PERF || answered) return;
        answered = true;
        expect(await answer(gate, SECURITY, answers("Yes"))).toEqual({
          ok: true,
        });
      },
    });

    await harness.run();

    // Nothing is parked — the answer beat the park — but `security` still owes
    // this candidate a verdict. The round may not conclude on its siblings and
    // the context may not complete over a lane that never reported.
    expect(answered).toBe(true);
    let contextState = harness.contextState()!;
    expect(contextState.status).toBe("running");
    expect(contextState.validationRound?.phase).toBe("specialists");
    expect(contextState.validationRound?.specialists[SECURITY]?.state).toBe(
      "parked",
    );
    expect(harness.results()).toHaveLength(0);
    expect(
      contextState.pendingUserInputs[SECURITY_KEY]?.answers?.byQuestionId,
    ).toEqual(answers("Yes"));

    asking = false;
    calls.length = 0;
    const consumed = await consume(gate);
    expect(consumed.map((entry) => entry.laneKey)).toEqual([SECURITY_KEY]);

    await harness.run({ resumeUserInputs: consumed });

    // The answer reaches the lane that asked, and only then does the round end.
    expect(calls).toEqual([SECURITY]);
    expect(received[SECURITY]).toEqual(answers("Yes"));
    contextState = harness.contextState()!;
    expect(contextState.pendingUserInputs).toEqual({});
    expect(contextState.validationRound?.outcome).toBe("passed");
    expect(harness.results()).toHaveLength(1);
  });

  it("resumes only the asking lane on a skipped answer, which completes with best judgment", async () => {
    let asking = true;
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => asking,
    });
    await harness.run();

    await answer(gate, SECURITY, skippedAnswers());
    await answer(gate, PERF, answers("No"));
    asking = false;
    const consumed = await consume(gate);
    calls.length = 0;

    await harness.run({ resumeUserInputs: consumed });

    // The skip is delivered as an answer to its own lane — the lane resumes and
    // renders a verdict rather than re-asking or stalling.
    expect(received[SECURITY]?.["q-1"]?.skipped).toBe(true);
    expect(received[PERF]?.["q-1"]?.skipped).toBe(false);
    expect(harness.contextState()!.validationRound?.outcome).toBe("passed");
  });

  it("restores a parked lane and a mid-review sibling independently — the park never serializes the cohort", async () => {
    // A reload mid-round: `general` had judged, `security` is parked on its
    // question, `perf` was still reviewing when the process died.
    const execution = withOpenRound(createCohortExecution(), {
      specialists: {
        general: specialistRecord({
          state: "verdict_pass",
          attempts: 0,
          summary: "general is satisfied.",
        }),
        [SECURITY]: specialistRecord({
          state: "parked",
          questionToken: `batch-${SECURITY}`,
        }),
        [PERF]: specialistRecord({ state: "running" }),
      },
    });
    const contextState = execution.contextStates[CONTEXT_ID]!;
    contextState.status = "awaiting_user_input";
    contextState.pendingUserInputs = {
      [SECURITY_KEY]: {
        conversationId: SECURITY_CONVERSATION,
        lane: "context_validator",
        questionBatchId: `batch-${SECURITY}`,
        questions: QUESTIONS,
        requestedAt: NOW,
        roundSeq: contextState.validationRound!.seq,
        answers: null,
      },
    };

    // Nothing asks on the rerun: the reload's job is to prove both lanes came
    // back independently, not to park again.
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => false,
      execution,
    });

    // The parked question survived the reload and is still answerable.
    expect(await answer(gate, SECURITY)).toEqual({ ok: true });
    const consumed = await consume(gate);
    expect(consumed.map((entry) => entry.laneKey)).toEqual([SECURITY_KEY]);

    await harness.run({ resumeUserInputs: consumed });

    // The mid-review sibling reruns alongside the answered lane; the retained
    // verdict does not. The parked lane held nobody up.
    expect(calls.sort()).toEqual([PERF, SECURITY].sort());
    expect(received[SECURITY]).toEqual(answers("Yes"));
    expect(received[PERF]).toBeNull();
    expect(harness.contextState()!.validationRound?.seq).toBe(
      execution.contextStates[CONTEXT_ID]!.validationRound!.seq,
    );
    expect(harness.contextState()!.validationRound?.outcome).toBe("passed");
  });

  it("discards a verdict completed before a candidate change once the candidate moves", async () => {
    let tree: ValidationCandidateTreeResolution = {
      kind: "resolved",
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-a",
    };
    let asking = true;
    const { harness, gate, calls, received } = buildAskingCohort({
      asking: () => asking,
      resolveCandidateTree: () => tree,
    });
    await harness.run();

    // `general` rendered a verdict against tree-a and it is retained on the
    // open round while the two askers wait.
    const firstRound = harness.contextState()!.validationRound!;
    expect(firstRound.specialists["general"]?.state).toBe("verdict_pass");

    await answer(gate, SECURITY);
    await answer(gate, PERF);
    asking = false;
    const consumed = await consume(gate);
    // The implementer moved the tree while the human was answering.
    tree = {
      kind: "resolved",
      identityScope: "wholeTree",
      headSha: "head-2",
      candidateTreeHash: "tree-b",
    };
    calls.length = 0;

    await harness.run({ resumeUserInputs: consumed });

    // The verdict was rendered against a tree the context has left behind, so
    // it is not carried: a NEW round freezes the new candidate and `general`
    // reviews again rather than its stale pass standing in for a review of
    // work it never saw.
    const round = harness.contextState()!.validationRound;
    expect(round?.seq).toBe(firstRound.seq + 1);
    expect(round?.candidate.candidateTreeHash).toBe("tree-b");
    expect(calls).toContain("general");
    expect(round?.phase).toBe("concluded");
    // The answers still reach only the lanes that asked for them.
    expect(received[SECURITY]).toEqual(answers("Yes"));
    expect(received["general"]).toBeNull();
    // Exactly one aggregate, and it belongs to the round that reviewed tree-b.
    expect(harness.results()).toHaveLength(1);
  });

  it("withdraws a question whose candidate moved out from under it and runs the new round clean", async () => {
    let tree: ValidationCandidateTreeResolution = {
      kind: "resolved",
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-a",
    };
    let asking = true;
    const { harness, gate, calls } = buildAskingCohort({
      asking: () => asking,
      resolveCandidateTree: () => tree,
    });
    await harness.run();
    const firstRoundSeq = harness.contextState()!.validationRound!.seq;

    // One lane is answered and resumes; the other is still waiting when the
    // tree it was asked about moves.
    await answer(gate, SECURITY);
    const consumed = await consume(gate);
    tree = {
      kind: "resolved",
      identityScope: "wholeTree",
      headSha: "head-2",
      candidateTreeHash: "tree-b",
    };
    asking = false;
    calls.length = 0;

    await harness.run({ resumeUserInputs: consumed });

    // A question about a tree the context has left behind is residue: it is
    // withdrawn with the round that asked it — exactly once, marker cleared —
    // rather than left standing over a candidate nobody is reviewing.
    const contextState = harness.contextState()!;
    expect(contextState.pendingUserInputs).toEqual({});
    expect(cleared).toEqual([PERF_CONVERSATION]);
    expect(
      broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "withdrawn",
      ),
    ).toHaveLength(1);
    expect(await answer(gate, PERF)).toEqual({
      ok: false,
      reason: "not_found",
    });

    // The new round freezes tree-b and every seat reviews it.
    expect(contextState.validationRound?.seq).toBe(firstRoundSeq + 1);
    expect(contextState.validationRound?.candidate.candidateTreeHash).toBe(
      "tree-b",
    );
    expect(calls.sort()).toEqual([PERF, SECURITY, "general"].sort());
    expect(contextState.validationRound?.outcome).toBe("passed");
    expect(harness.results()).toHaveLength(1);
  });

  it("pause-to-edit cancels every parked question exactly once and leaves the next round residue-free", async () => {
    let asking = true;
    const { harness, gate, calls } = buildAskingCohort({
      asking: () => asking,
    });
    await harness.run();
    const pausedRoundSeq = harness.contextState()!.validationRound!.seq;

    // The operator pauses to edit the roster while an answer is in flight: the
    // answer either lands before the withdrawal or dies on its token.
    const racingAnswer = answer(gate, SECURITY);
    await harness.pause();
    await racingAnswer;

    let contextState = harness.contextState()!;
    expect(contextState.pendingUserInputs).toEqual({});
    expect(contextState.validationRound?.phase).toBe("concluded");
    // Exactly once per parked conversation — a second pause finds nothing.
    expect(cleared.sort()).toEqual(
      [PERF_CONVERSATION, SECURITY_CONVERSATION].sort(),
    );
    expect(
      broadcasts.filter(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "withdrawn",
      ),
    ).toHaveLength(2);
    // The answer that raced the pause cannot resolve a dead question.
    expect(await answer(gate, PERF)).toEqual({
      ok: false,
      reason: "not_found",
    });

    // The next round starts clean: a fresh seq, no parked residue, and every
    // seat re-dispatched.
    asking = false;
    calls.length = 0;
    await harness.resumeHalt();
    // The scheduler owns ready -> running; this harness drives the iteration
    // directly, so it stands in for that one transition.
    await harness.repository.mutateActive("/repo", "session-1", (latest) => {
      const next = structuredClone(latest);
      next.contextStates[CONTEXT_ID]!.status = "running";
      return next;
    });
    await harness.run();

    contextState = harness.contextState()!;
    expect(contextState.validationRound?.seq).toBe(pausedRoundSeq + 1);
    expect(contextState.pendingUserInputs).toEqual({});
    expect(calls.sort()).toEqual([PERF, SECURITY, "general"].sort());
    expect(contextState.validationRound?.outcome).toBe("passed");
  });

  it("keeps an implementer's parked question across a pause", async () => {
    let asking = true;
    const { harness, gate } = buildAskingCohort({ asking: () => asking });
    await harness.run();

    // An implementer park belongs to no round — the operator pausing to edit
    // the validator roster is not asking to lose it.
    await gate.enterAwaitingUserInput({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: CONTEXT_ID,
      laneKey: laneStateKey("implementer"),
      conversationId: "conversation-implementer",
      questionBatchId: "batch-implementer",
      questions: QUESTIONS,
    });

    await harness.pause();
    asking = false;

    const parked = harness.contextState()!.pendingUserInputs;
    expect(Object.keys(parked)).toEqual([laneStateKey("implementer")]);
    expect(cleared).not.toContain("conversation-implementer");
  });

  it("withdraws every parked question, implementer included, on abort", async () => {
    const { harness, gate } = buildAskingCohort({ asking: () => true });
    await harness.run();

    await gate.withdrawAll({
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: harness.repository.read().id,
    });

    expect(harness.contextState()!.pendingUserInputs).toEqual({});
    expect(cleared.sort()).toEqual(
      [PERF_CONVERSATION, SECURITY_CONVERSATION].sort(),
    );
  });
});
