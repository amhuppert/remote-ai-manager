import { z } from "zod";
import type { ExecutorKind } from "@/lib/intents/schemas";
import {
  ADVICE_RESPONSE_OUTPUT_SCHEMA,
  adviceItemsOf,
  adviceStanding,
  type AdviceItem,
} from "./advice";
import { reserveAllowance } from "./allowances";
import { approvalStanding } from "./approval";
import {
  composeAdvice,
  composeCapture,
  composeContinuation,
  composeInitialWork,
  composeRemediation,
  composeRetryWork,
  composeReview,
  composeRework,
  composeSteer,
} from "./briefing";
import { currentCandidate } from "./candidates";
import {
  REVIEW_VERDICT_OUTPUT_SCHEMA,
  activeRound,
  certificationStanding,
  openRound,
} from "./certification";
import { nextProgress } from "./progress";
import {
  workspaceBindingRequestSchema,
  workspaceScopeSchema,
} from "@/lib/workspace/schemas";
import {
  allowanceKindSchema,
  seatAssignmentSchema,
  type AllowanceKind,
  type ContextFacts,
  type SeatAssignment,
} from "./schemas";

/** The seat a conversation effect targets; the executor spawns it on first use. */
export const seatRefSchema = z
  .object({
    contextId: z.string().min(1),
    assignmentId: z.string().min(1),
    role: z.enum(["implementer", "reviewer"]),
    assignment: seatAssignmentSchema,
    conversationId: z.string().min(1).nullable(),
    replacement: z.number().int().min(0),
    /** Whether the seat may ask its owner a question; the contract decides. */
    canAsk: z.boolean(),
  })
  .strict();
export type SeatRef = z.infer<typeof seatRefSchema>;

const outputSchemaSchema = z.record(z.string(), z.unknown());

/** The workspace access a seat turn needs; Conversation acquires it at admission. */
export const seatAccessSchema = z
  .object({
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    worktreePath: z.string().min(1),
    access: z.enum(["write", "stable_read", "observe"]),
    scope: workspaceScopeSchema,
  })
  .strict();
export type SeatAccess = z.infer<typeof seatAccessSchema>;

const adviceItemSchema = z
  .object({
    id: z.string(),
    roundId: z.string(),
    assignmentId: z.string(),
    title: z.string(),
    description: z.string(),
  })
  .strict();

/** The exact request each effect carries; stored with its pending intent. */
export const contextEffectRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("work"),
      workspace: seatAccessSchema,
      reason: z.enum(["initial", "retry", "steer", "remediate", "rework", "continue"]),
      seat: seatRefSchema,
      message: z.string().min(1),
      allowance: allowanceKindSchema.nullable(),
      steerId: z.string().optional(),
      questionId: z.string().optional(),
      candidateId: z.string().optional(),
      timeoutMs: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("capture_output"),
      workspace: seatAccessSchema,
      seat: seatRefSchema,
      message: z.string().min(1),
      outputSchema: outputSchemaSchema,
      timeoutMs: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      workspace: seatAccessSchema,
      seat: seatRefSchema,
      roundId: z.string().min(1),
      message: z.string().min(1),
      outputSchema: outputSchemaSchema,
      questionId: z.string().optional(),
      timeoutMs: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("advise"),
      workspace: seatAccessSchema,
      seat: seatRefSchema,
      roundId: z.string().min(1),
      message: z.string().min(1),
      items: z.array(adviceItemSchema),
      outputSchema: outputSchemaSchema,
      timeoutMs: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bind"),
      bindingId: z.string().min(1),
      binding: workspaceBindingRequestSchema,
    })
    .strict(),
  z.object({ kind: z.literal("freeze"), bindingId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("check"),
      bindingId: z.string().min(1),
      roundId: z.string().min(1),
      candidateId: z.string().min(1),
      evidence: z.string().min(1),
      command: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verify"),
      bindingId: z.string().min(1),
      candidateId: z.string().min(1),
      evidence: z.string().min(1),
      roundId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accept"),
      bindingId: z.string().min(1),
      candidateId: z.string().min(1),
      evidence: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("answer"), questionId: z.string().min(1) }).strict(),
]);
export type ContextEffectRequest = z.infer<typeof contextEffectRequestSchema>;

export interface PlannedEffect {
  executor: ExecutorKind;
  cause: string;
  request: ContextEffectRequest;
}

export function executorFor(request: ContextEffectRequest): ExecutorKind {
  switch (request.kind) {
    case "work":
    case "capture_output":
    case "review":
    case "advise":
      return "conversation";
    case "bind":
    case "freeze":
    case "check":
    case "verify":
    case "accept":
      return "workspace";
    case "answer":
      return "requests";
  }
}

/** Effects that wait on a person rather than run. */
export function waitsOnPerson(request: ContextEffectRequest): boolean {
  return request.kind === "answer";
}

const IMPLEMENTER = "implementer";

function seatAccess(facts: ContextFacts, access: SeatAccess["access"]): SeatAccess {
  const binding = facts.binding.request;
  const effective = access === "write" && binding.scope.mode === "readOnly" ? "observe" : access;
  return {
    projectPath: binding.projectPath,
    sessionName: binding.sessionName,
    worktreePath: binding.worktreePath,
    access: effective,
    scope: binding.scope,
  };
}

/** Numbers a new effect so its cause is never reused, even after a withdrawal. */
function allocateCause(
  facts: ContextFacts,
  kind: string,
): { facts: ContextFacts; cause: string } {
  const effectSequence = facts.effectSequence + 1;
  return {
    facts: { ...facts, effectSequence },
    cause: `${facts.contextId}:${kind}:${effectSequence}`,
  };
}

function seatRef(
  facts: ContextFacts,
  contextId: string,
  assignmentId: string,
  role: SeatRef["role"],
  assignment: SeatAssignment,
): SeatRef {
  return {
    contextId,
    assignmentId,
    role,
    assignment,
    conversationId: facts.seats.conversations[assignmentId] ?? null,
    replacement: facts.seats.replacements[assignmentId] ?? 0,
    canAsk: facts.contract.current.ownerQuestions,
  };
}

function implementerSeat(facts: ContextFacts, contextId: string): SeatRef {
  return seatRef(facts, contextId, IMPLEMENTER, "implementer", facts.contract.current.implementer);
}

/**
 * Plans the effects of the current obligation. Called only when the permit
 * admits and nothing is pending; records any fact the plan itself needs (a new
 * review round, a reserved allowance, the effect sequence) in the returned facts.
 */
export function planEffects(input: {
  facts: ContextFacts;
}): { facts: ContextFacts; effects: PlannedEffect[] } {
  let facts = input.facts;
  const contextId = facts.contextId;
  // Control facts outrank the acceptance chain: nothing new starts while the
  // context is cancelled, halted or paused.
  const control = facts.control;
  if (control.cancelled || control.halt !== null || control.paused) return { facts, effects: [] };
  const progress = nextProgress(facts);
  if (progress.kind !== "running" && progress.kind !== "waiting") {
    return { facts, effects: [] };
  }
  const timeoutMs = facts.policy.invocationTimeoutMs;
  const nextCause = (kind: string): string => {
    const allocated = allocateCause(facts, kind);
    facts = allocated.facts;
    return allocated.cause;
  };
  const obligation = progress.obligation;

  switch (obligation.kind) {
    case "bind":
      return {
        facts,
        effects: [
          {
            executor: "workspace",
            cause: `${contextId}:bind`,
            request: { kind: "bind", bindingId: contextId, binding: facts.binding.request },
          },
        ],
      };
    case "work":
      return planWork(facts, contextId, obligation.reason, timeoutMs);
    case "capture_output": {
      const outputSchema = facts.contract.current.outputSchema;
      if (outputSchema === null) return { facts, effects: [] };
      const cause = nextCause("capture");
      return {
        facts,
        effects: [
          {
            executor: "conversation",
            cause,
            request: {
              kind: "capture_output",
              workspace: seatAccess(facts, "observe"),
              seat: implementerSeat(facts, contextId),
              message: composeCapture(),
              outputSchema,
              timeoutMs,
            },
          },
        ],
      };
    }
    case "freeze": {
      const cause = nextCause("freeze");
      return {
        facts,
        effects: [{ executor: "workspace", cause, request: { kind: "freeze", bindingId: contextId } }],
      };
    }
    case "certify": {
      const candidate = currentCandidate(facts);
      if (candidate === null) return { facts, effects: [] };
      let round = activeRound(facts, candidate);
      if (round === null) {
        facts = openRound(facts, { contextId, candidate });
        round = activeRound(facts, candidate);
      }
      if (round === null) return { facts, effects: [] };
      const pendingChecks = round.checks.filter((c) => c.status === "pending");
      if (pendingChecks.length > 0) {
        const roundId = round.id;
        return {
          facts,
          effects: pendingChecks.map((check) => ({
            executor: "workspace" as const,
            cause: `${contextId}:check:${roundId}:${check.command}`,
            request: {
              kind: "check" as const,
              bindingId: contextId,
              roundId,
              candidateId: candidate.id,
              evidence: candidate.evidence,
              command: check.command,
            },
          })),
        };
      }
      const reviewers = facts.contract.current.reviewers;
      const effects: PlannedEffect[] = [];
      for (const seat of round.seats) {
        if (seat.status !== "pending") continue;
        const assignment = reviewers.find((r) => r.id === seat.assignmentId);
        if (assignment === undefined) continue;
        effects.push({
          executor: "conversation",
          cause: nextCause("review"),
          request: {
            kind: "review",
            workspace: seatAccess(facts, "stable_read"),
            seat: seatRef(facts, contextId, assignment.id, "reviewer", assignment),
            roundId: round.id,
            message: composeReview(facts, { candidate, round, seat: assignment }),
            outputSchema: REVIEW_VERDICT_OUTPUT_SCHEMA,
            timeoutMs,
          },
        });
      }
      return { facts, effects };
    }
    case "advise": {
      const candidate = currentCandidate(facts);
      if (candidate === null) return { facts, effects: [] };
      const advice = adviceStanding(facts, certificationStanding(facts, candidate));
      if (advice.kind !== "owed") return { facts, effects: [] };
      const pendingItems = advice.items.filter(
        (item) => facts.advice.dispositions[item.id] === undefined,
      );
      const roundId = pendingItems[0]?.roundId ?? advice.items[0]?.roundId;
      if (roundId === undefined) return { facts, effects: [] };
      const cause = nextCause("advise");
      return {
        facts,
        effects: [
          {
            executor: "conversation",
            cause,
            request: {
              kind: "advise",
              workspace: seatAccess(facts, "write"),
              seat: implementerSeat(facts, contextId),
              roundId,
              message: composeAdvice(advice.items),
              items: advice.items,
              outputSchema: ADVICE_RESPONSE_OUTPUT_SCHEMA,
              timeoutMs,
            },
          },
        ],
      };
    }
    case "verify": {
      const candidate = currentCandidate(facts);
      const pending = facts.candidates.verifyPending;
      if (candidate === null || pending === null) return { facts, effects: [] };
      const cause = nextCause("verify");
      return {
        facts,
        effects: [
          {
            executor: "workspace",
            cause,
            request: {
              kind: "verify",
              bindingId: contextId,
              candidateId: candidate.id,
              evidence: candidate.evidence,
              roundId: pending.roundId,
            },
          },
        ],
      };
    }
    case "await_answer":
      return {
        facts,
        effects: [
          {
            executor: "requests",
            cause: `${contextId}:answer:${obligation.questionId}`,
            request: { kind: "answer", questionId: obligation.questionId },
          },
        ],
      };
    case "await_approval":
      return { facts, effects: [] };
    case "accept": {
      const candidate = currentCandidate(facts);
      if (candidate === null) return { facts, effects: [] };
      return {
        facts,
        effects: [
          {
            executor: "workspace",
            cause: `${contextId}:accept:${candidate.id}`,
            request: {
              kind: "accept",
              bindingId: contextId,
              candidateId: candidate.id,
              evidence: candidate.evidence,
            },
          },
        ],
      };
    }
  }
}

function planWork(
  initial: ContextFacts,
  contextId: string,
  reason: "initial" | "retry" | "steer" | "remediate" | "rework" | "continue",
  timeoutMs: number | null,
): { facts: ContextFacts; effects: PlannedEffect[] } {
  let facts = initial;
  const nextCause = (kind: string): string => {
    const allocated = allocateCause(facts, kind);
    facts = allocated.facts;
    return allocated.cause;
  };
  if (reason === "continue") {
    const answered = facts.requests.answered.find((a) => !a.continued);
    if (answered === undefined) return { facts, effects: [] };
    const question = answered.questionId;
    const message = composeContinuation(answered.question, answered.answer);
    if (answered.seat !== IMPLEMENTER) {
      return planReviewContinuation(facts, contextId, answered.seat, question, message, timeoutMs);
    }
    const cause = nextCause("work");
    return {
      facts,
      effects: [
        {
          executor: "conversation",
          cause,
          request: {
            kind: "work",
            workspace: seatAccess(facts, "write"),
            reason,
            seat: implementerSeat(facts, contextId),
            message,
            allowance: null,
            questionId: question,
            timeoutMs,
          },
        },
      ],
    };
  }

  const allowance: AllowanceKind | null =
    reason === "retry"
      ? "unfinishedTaskRetries"
      : reason === "remediate"
        ? "validationRetries"
        : null;
  const cause = nextCause("work");
  if (allowance !== null) facts = reserveAllowance(facts, allowance, cause);

  let message: string;
  const extra: { steerId?: string; candidateId?: string } = {};
  switch (reason) {
    case "initial":
      message = composeInitialWork(facts);
      break;
    case "retry":
      message = composeRetryWork(facts);
      break;
    case "steer": {
      const steer = facts.control.steers.find((s) => !s.consumed);
      if (steer === undefined) return { facts: initial, effects: [] };
      message = composeSteer(facts, steer.instruction);
      extra.steerId = steer.id;
      break;
    }
    case "remediate": {
      const candidate = currentCandidate(facts);
      if (candidate === null) return { facts: initial, effects: [] };
      const standing = certificationStanding(facts, candidate);
      if (standing.kind !== "failed") return { facts: initial, effects: [] };
      const carried: AdviceItem[] = adviceItemsOf(standing.round);
      message = composeRemediation(facts, standing.findings, carried);
      extra.candidateId = candidate.id;
      break;
    }
    case "rework": {
      const candidate = currentCandidate(facts);
      if (candidate === null) return { facts: initial, effects: [] };
      const approval = approvalStanding(facts, candidate);
      message = composeRework(facts, approval.kind === "rejected" ? approval.notes : null);
      extra.candidateId = candidate.id;
      break;
    }
  }
  return {
    facts,
    effects: [
      {
        executor: "conversation",
        cause,
        request: {
          kind: "work",
          workspace: seatAccess(facts, "write"),
          reason,
          seat: implementerSeat(facts, contextId),
          message,
          allowance,
          ...extra,
          timeoutMs,
        },
      },
    ],
  };
}

function planReviewContinuation(
  facts: ContextFacts,
  contextId: string,
  assignmentId: string,
  questionId: string,
  message: string,
  timeoutMs: number | null,
): { facts: ContextFacts; effects: PlannedEffect[] } {
  const candidate = currentCandidate(facts);
  const assignment = facts.contract.current.reviewers.find((r) => r.id === assignmentId);
  const round = candidate === null ? null : activeRound(facts, candidate);
  if (assignment === undefined || round === null) return { facts, effects: [] };
  return {
    facts,
    effects: [
      {
        executor: "conversation",
        cause: `${contextId}:review:${round.id}:${assignmentId}:${questionId}`,
        request: {
          kind: "review",
          workspace: seatAccess(facts, "stable_read"),
          seat: seatRef(facts, contextId, assignmentId, "reviewer", assignment),
          roundId: round.id,
          message,
          outputSchema: REVIEW_VERDICT_OUTPUT_SCHEMA,
          questionId,
          timeoutMs,
        },
      },
    ],
  };
}
