import type { ApprovalCandidate } from "@/components/ApprovalGatePanel";
import type { AgentBackendId } from "@/lib/shared/schemas";

/**
 * What the run page renders: the run as its owner and the person read it.
 * The server's run view grows into this shape; every field is something the
 * engine already knows (design r2 §12, amendment 17).
 */

export type RunKind = "agent" | "workflow";

/** A run's progress (the Run's derived progress, as shown). */
export type RunStatus =
  | { kind: "running" }
  | { kind: "needs_input" }
  | { kind: "paused"; draining: boolean }
  | { kind: "stopping" }
  | { kind: "succeeded" }
  | { kind: "cancelled" };

export interface RunOwner {
  conversationId: string;
  title: string;
  backend: AgentBackendId;
}

/** A row in the session's run list. */
export interface RunSummary {
  runId: string;
  title: string;
  kind: RunKind;
  status: RunStatus;
  /** Approvals, halts and lane stops the person can act on. */
  attention: number;
  contexts: { done: number; total: number };
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  owner: RunOwner;
}

/** The engine's halt kinds (Context, then Run). */
export type ContextHaltKind =
  | "retries_exhausted"
  | "output_invalid"
  | "candidate_unstable"
  | "plan_defect"
  | "advice_invalid"
  | "unavailable"
  | "turn_failed"
  | "interrupted"
  | "effect_uncertain"
  | "reconcile_failed"
  | "workspace_refused";

export type RunHaltKind =
  | "route_unevaluable"
  | "route_cardinality"
  | "loop_exhausted"
  | "loop_unevaluable"
  | "lane_provision"
  | "lane_publication"
  | "reconcile_failed";

/** A remedy the engine offers for a halt; each maps to one disposition. */
export type Remedy =
  | { kind: "continue" }
  | { kind: "retry" }
  | { kind: "replace_seat" }
  | { kind: "retry_capture" }
  | { kind: "retry_advice" }
  | { kind: "rereview" }
  | { kind: "confirm_effect" }
  | { kind: "grant"; allowance: "unfinishedTaskRetries" | "validationRetries"; used: number; limit: number };

export interface ContextHalt {
  kind: ContextHaltKind;
  detail: string;
  occurrence: string;
  at: string;
  remedies: Remedy[];
  seat?: string;
}

/** The lifecycle step a context is on, from its obligation. */
export type ContextStep =
  | { kind: "workspace" }
  | { kind: "work"; reason: "initial" | "retry" | "steer" | "remediate" | "rework" | "continue" }
  | { kind: "output" }
  | { kind: "review"; round: number; roundKind: "full" | "blocking"; reviewersDone: number; reviewersTotal: number }
  | { kind: "advice" }
  | { kind: "verify" }
  | { kind: "accept" };

export type ContextState =
  | { kind: "waiting"; dependencies: string[]; provisionLanes: string[]; publicationLanes: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "running"; step: ContextStep }
  | { kind: "awaiting_answer" }
  | { kind: "awaiting_approval"; requestedAt: string }
  | { kind: "halted"; halt: ContextHalt }
  | { kind: "paused"; next: ContextStep | null; draining: boolean }
  | { kind: "stopping" }
  | { kind: "succeeded"; at: string }
  | { kind: "cancelled" };

export type ContextPlacement = { kind: "session" } | { kind: "lane"; lane: string };

export interface SeatSummary {
  role: "implementer" | "reviewer";
  backend: AgentBackendId;
  model: string;
  effort: string | null;
  profile?: string;
  /** Reviewers only. */
  authority?: "blocking" | "advisory";
  focus?: string;
}

/** One context key's current invocation, as a list row. */
export interface RunContext {
  key: string;
  title: string;
  placement: ContextPlacement;
  loop: { key: string; pass: number; maxPasses: number } | null;
  dependsOn: string[];
  state: ContextState;
  tasks: { done: number; total: number };
  costUsd: number | null;
  implementer: SeatSummary;
  reviewers: SeatSummary[];
  humanApproval: boolean;
  startedAt: string | null;
  questions: Array<{ questionId: string; seat: string; question: string; askedAt: string }>;
}

/** One stage of the context lifecycle, for the stage track. */
export interface ContextStage {
  key: "workspace" | "work" | "output" | "review" | "approval" | "accept";
  label: string;
  state: "done" | "current" | "waiting" | "halted" | "pending" | "skipped";
  note?: string;
}

export interface Finding {
  title: string;
  description: string;
  criterionId?: string;
}

export interface Advisory extends Finding {
  disposition: "addressed" | "declined" | "deferred" | null;
  dispositionNote?: string;
}

export interface SeatVerdict {
  assignment: string;
  seat: SeatSummary;
  status: "pending" | "pass" | "fail" | "defect" | "unavailable";
  findings: Finding[];
  advisories: Advisory[];
  costUsd: number | null;
}

export interface CheckResult {
  command: string;
  status: "running" | "passed" | "failed";
  durationMs: number | null;
  detail?: string;
}

export interface ReviewRound {
  number: number;
  kind: "full" | "blocking";
  outcome: "running" | "passed" | "failed" | "retired";
  checks: CheckResult[];
  seats: SeatVerdict[];
  at: string;
}

/** One conversation a context's seat held, including replaced incarnations. */
export interface SeatConversation {
  conversationId: string;
  assignment: string;
  seat: SeatSummary;
  status: "active" | "idle" | "replaced" | "finished";
  replacedBecause?: string;
  turns: number;
  costUsd: number;
}

export interface FrozenDocument {
  path: string;
  revision: number;
  /** How the current declaration differs from this invocation's frozen revision. */
  later: "superseded" | "removed" | null;
}

/** Resolved execution policy and workspace grant, as held by this invocation. */
export interface ContextConfiguration {
  checks: string[];
  deferredChecks: string[];
  ownerQuestions: boolean;
  allowTaskAddition: boolean;
  documentPublishing: boolean;
  scope: { mode: "full" | "readOnly" } | { mode: "owned"; paths: string[] };
  worktreePath: string;
  branch: string;
  outputSchema: Record<string, unknown> | null;
  policy: {
    unfinishedTaskRetries: { used: number; limit: number };
    validationRetries: { used: number; limit: number };
    captureRepairLimit: number;
    instabilityLimit: number;
    adviceCorrectionLimit: number;
    invocationTimeoutMs: number | null;
  };
}

export interface ContextInvocation extends RunContext {
  invocationId: string;
  brief: string;
  taskList: Array<{ id: string; title: string; done: boolean }>;
  criteria: Array<{ id: string; text: string }>;
  stages: ContextStage[];
  reviews: ReviewRound[];
  output: { status: "accepted" | "candidate"; value: unknown } | null;
  inputs: Array<{ key: string; title: string; output: unknown }>;
  agents: SeatConversation[];
  froze: { charter: number | null; documents: FrozenDocument[] } | null;
  approval: { candidateId: string; requestedAt: string } | null;
  candidate: ApprovalCandidate | null;
  lastSummary: string | null;
  configuration: ContextConfiguration;
}

export interface ContextDetail extends ContextInvocation {
  /** Full retained evidence, without another recursive history. */
  previousInvocations: ContextInvocation[];
}

export type LaneState =
  | "waiting"
  | "skipped"
  | "cancelled"
  | "provisioning"
  | "provision_failed"
  | "working"
  | "publishing"
  | "published"
  | "blocked"
  | "stale"
  | "failed"
  | "uncertain";

export interface RunLane {
  key: string;
  branch: string;
  worktreePath: string;
  state: LaneState;
  attempt: number | null;
  detail: string | null;
  commit: string | null;
  checks: string[];
}

export interface RunLoop {
  key: string;
  body: string[];
  pass: number;
  maxPasses: number;
  state: "unstarted" | "skipped" | "running" | "next" | "succeeded" | "exhausted" | "unevaluable";
  until: string;
}

/** A dependency as the diagram draws it. */
export interface RunEdge {
  from: string;
  to: string;
  guard: { label: string; state: "taken" | "not_taken" | "undecided" } | null;
  outputOnly: boolean;
}

export interface RunDocument {
  path: string;
  revision: number;
  source: "launch" | "amend" | "publish";
  by?: string;
  reason?: string;
  description: string;
  readWhen?: string;
  appliesTo?: string[];
  bytes: number;
  contents: string;
}

export interface RunCharter {
  revision: number;
  reason: string | null;
  mission: string;
  conventions: string[];
  vocabulary: string[];
  testStrategy: string | null;
  knownAmbiguities: string[];
  invariants: Array<{ id: string; statement: string; appliesTo?: string[] }>;
  sources: Array<{ rank: number; label: string; locator: string; description: string; appliesTo?: string[] }>;
  nonGoals: string[];
}

export type ActivityKind =
  | "launched"
  | "started"
  | "question"
  | "answered"
  | "halted"
  | "resolved"
  | "approval"
  | "decided"
  | "published"
  | "amended"
  | "succeeded"
  | "paused"
  | "resumed"
  | "cancelled";

export interface ActivityEvent {
  seq: number;
  at: string;
  kind: ActivityKind;
  summary: string;
  contextKey?: string;
}

/** What needs the person, or the owner, now. */
export type AttentionItem =
  | { kind: "approval"; contextKey: string; contextTitle: string; requestedAt: string; reviewersPassed: number }
  | { kind: "halt"; contextKey: string; contextTitle: string; halt: ContextHaltKind; detail: string; at: string }
  | { kind: "run_halt"; occurrence: string; halt: RunHaltKind; detail: string; clearedBy: "amend" | "retry_lane" | "cancel" | "resume"; lane?: string; at: string }
  | { kind: "question"; questionId: string; contextKey: string; contextTitle: string; seat: string; question: string; askedAt: string };

export interface RunDetail {
  runId: string;
  title: string;
  kind: RunKind;
  status: RunStatus;
  owner: RunOwner;
  definitionRevision: number;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  attention: AttentionItem[];
  contexts: ContextDetail[];
  edges: RunEdge[];
  lanes: RunLane[];
  loops: RunLoop[];
  documents: RunDocument[];
  documentHistory: RunDocument[];
  charter: RunCharter | null;
  charterHistory: RunCharter[];
  activity: ActivityEvent[];
  definition: Record<string, unknown> | null;
}
