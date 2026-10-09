import type { z } from "zod";
import type {
  advisoryViewSchema,
  checkResultViewSchema,
  ContextConfiguration as ContextConfigurationView,
  ContextHaltView,
  ContextStage as ContextStageView,
  ContextState as ContextStateView,
  ContextStep as ContextStepView,
  haltKindSchema,
  Remedy as RemedyView,
  ReviewRoundView,
  SeatSummary as SeatSummaryView,
  seatVerdictViewSchema,
} from "@/lib/execution-context/schemas";
import type {
  activityEventSchema,
  attentionItemSchema,
  ContextDetail as ContextDetailView,
  ContextInvocation as ContextInvocationView,
  RunPage,
  runEdgeSchema,
  runLaneStatusSchema,
  runOwnerSchema,
  runPageCharterSchema,
  runPageDocumentSchema,
  runPageLaneSchema,
  runPageLoopSchema,
  RunStatus as RunStatusView,
  RunSummary as RunSummaryView,
  seatConversationSchema,
} from "@/lib/runs/schemas";

/**
 * What the run page renders: the run as its owner and the person read it.
 * These are the server's run page types (src/lib/runs/schemas.ts, and the
 * Context's own view in src/lib/execution-context/schemas.ts), named as the
 * page's components use them (design r2 §9, amendments 17 and 19).
 */

export type RunDetail = RunPage;
export type RunSummary = RunSummaryView;
export type RunStatus = RunStatusView;
export type RunOwner = z.infer<typeof runOwnerSchema>;

export type ContextHaltKind = z.infer<typeof haltKindSchema>;
export type RunHaltKind = Extract<
  RunPage["attention"][number],
  { kind: "run_halt" }
>["halt"];
export type Remedy = RemedyView;
export type ContextHalt = ContextHaltView;
export type ContextStep = ContextStepView;
export type ContextState = ContextStateView;
export type SeatSummary = SeatSummaryView;
export type ContextStage = ContextStageView;

export type Advisory = z.infer<typeof advisoryViewSchema>;
export type SeatVerdict = z.infer<typeof seatVerdictViewSchema>;
export type CheckResult = z.infer<typeof checkResultViewSchema>;
export type ReviewRound = ReviewRoundView;
export type SeatConversation = z.infer<typeof seatConversationSchema>;
export type ContextConfiguration = ContextConfigurationView;

/** One context key's current invocation. */
export type ContextInvocation = ContextInvocationView;
/** A context key as a list row, and as the diagram and template editor draw it. */
export type RunContext = Pick<
  ContextInvocationView,
  | "key"
  | "title"
  | "placement"
  | "loop"
  | "dependsOn"
  | "state"
  | "tasks"
  | "costUsd"
  | "costComplete"
  | "implementer"
  | "reviewers"
  | "humanApproval"
  | "startedAt"
  | "questions"
>;
export type ContextDetail = ContextDetailView;
export type CandidateChanges = NonNullable<ContextInvocationView["candidate"]>;

export type LaneState = z.infer<typeof runLaneStatusSchema>;
export type RunLane = z.infer<typeof runPageLaneSchema>;
export type RunLoop = z.infer<typeof runPageLoopSchema>;
export type RunEdge = z.infer<typeof runEdgeSchema>;
export type RunDocument = z.infer<typeof runPageDocumentSchema>;
export type RunCharter = z.infer<typeof runPageCharterSchema>;

export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type ActivityKind = ActivityEvent["kind"];
export type AttentionItem = z.infer<typeof attentionItemSchema>;
