import type {
  Spec,
  SpecAssumptionCitation,
  SpecAssumptionRow,
  SpecAttentionRecordPresentation,
  SpecEventRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
} from "./schemas";
import {
  actorProvenanceSchema,
  specAttentionRecordPresentationSchema,
  specReviewRecordMutatedEventPayloadSchema,
} from "./schemas";

export interface AttentionCitationProjection {
  readonly revisionId: string;
  readonly citationVersion: number;
  readonly citationHash: string;
  readonly citations: readonly SpecAssumptionCitation[];
}

export interface QuestionAttentionProjection {
  readonly row: SpecQuestionRow;
  readonly presentation: SpecAttentionRecordPresentation;
}

export interface AssumptionAttentionProjection {
  readonly row: SpecAssumptionRow;
  readonly supersededByAssumptionId: string | null;
  readonly presentation: SpecAttentionRecordPresentation;
  readonly currentDraftCitations: AttentionCitationProjection | null;
}

export interface AttentionRecordsProjection {
  readonly currentQuestions: readonly QuestionAttentionProjection[];
  readonly currentAssumptions: readonly AssumptionAttentionProjection[];
  readonly history: readonly (
    | ({ readonly kind: "question" } & QuestionAttentionProjection)
    | ({ readonly kind: "assumption" } & AssumptionAttentionProjection)
  )[];
}

export function projectAttentionRecords(input: {
  readonly spec: Spec;
  readonly revisions: readonly SpecRevision[];
  readonly currentDraftSnapshot: SpecRevisionSnapshot | null;
  readonly frozenSnapshots: readonly SpecRevisionSnapshot[];
  readonly questions: readonly SpecQuestionRow[];
  readonly assumptions: readonly SpecAssumptionRow[];
  readonly events: readonly SpecEventRow[];
}): AttentionRecordsProjection {
  const latestMutationByRecordId = new Map<
    string,
    SpecAttentionRecordPresentation["lastMutation"]
  >();
  for (const event of [...input.events].sort(
    (left, right) =>
      left.occurred_at.localeCompare(right.occurred_at) || left.id - right.id,
  )) {
    if (event.event_type !== "spec-review-record-mutated") continue;
    let payload: unknown;
    let actor: unknown;
    try {
      payload = JSON.parse(event.payload_json);
      actor = JSON.parse(event.actor_json);
    } catch {
      continue;
    }
    const parsedPayload =
      specReviewRecordMutatedEventPayloadSchema.safeParse(payload);
    const parsedActor = actorProvenanceSchema.safeParse(actor);
    if (!parsedPayload.success || !parsedActor.success) continue;
    latestMutationByRecordId.set(parsedPayload.data.recordId, {
      operation: parsedPayload.data.operation,
      actor: parsedActor.data,
      occurredAt: event.occurred_at,
    });
  }

  const successorByPredecessor = new Map(
    input.assumptions.flatMap((assumption) =>
      assumption.supersedes_assumption_id === null
        ? []
        : [[assumption.supersedes_assumption_id, assumption.id] as const],
    ),
  );
  const frozenCitationByAssumption = new Map<string, SpecRevision>();
  for (const snapshot of [...input.frozenSnapshots].sort(
    (left, right) => right.revision.number - left.revision.number,
  )) {
    for (const citation of snapshot.assumptionCitations) {
      if (!frozenCitationByAssumption.has(citation.assumptionId)) {
        frozenCitationByAssumption.set(
          citation.assumptionId,
          snapshot.revision,
        );
      }
    }
  }

  const questionProjections = input.questions.map(
    (row): QuestionAttentionProjection => {
      const history = row.status === "withdrawn";
      const humanCapability: SpecAttentionRecordPresentation["humanCapability"] =
        input.spec.abandonedAt !== null
          ? {
              kind: "answer",
              allowed: false,
              code: "read_only",
              blockingRevisionId: null,
              instruction:
                "This spec is abandoned and its attention register is read-only.",
            }
          : row.status === "open"
            ? { kind: "answer", allowed: true }
            : {
                kind: "answer",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction:
                  "This question has a terminal answer or withdrawal.",
              };
      return {
        row,
        presentation: specAttentionRecordPresentationSchema.parse({
          state: history ? "history" : "current",
          attentionActive: !history && row.status === "open",
          lastMutation: latestMutationByRecordId.get(row.id) ?? null,
          humanCapability,
        }),
      };
    },
  );

  const assumptionProjections = input.assumptions.map(
    (row): AssumptionAttentionProjection => {
      const supersededByAssumptionId =
        successorByPredecessor.get(row.id) ?? null;
      const history =
        row.disposition === "withdrawn" || supersededByAssumptionId !== null;
      const frozenRevision = frozenCitationByAssumption.get(row.id) ?? null;
      const humanCapability: SpecAttentionRecordPresentation["humanCapability"] =
        input.spec.abandonedAt !== null
          ? {
              kind: "dispose",
              allowed: false,
              code: "read_only",
              blockingRevisionId: null,
              instruction:
                "This spec is abandoned and its attention register is read-only.",
            }
          : row.disposition !== "proposed" || history
            ? {
                kind: "dispose",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction:
                  "This assumption is terminal; correct it through supersession.",
              }
            : frozenRevision !== null && input.currentDraftSnapshot === null
              ? {
                  kind: "dispose",
                  allowed: false,
                  code: "amendment_required",
                  blockingRevisionId: frozenRevision.id,
                  instruction:
                    "Open an amendment before recording this disposition.",
                }
              : { kind: "dispose", allowed: true };
      const draft = input.currentDraftSnapshot;
      return {
        row,
        supersededByAssumptionId,
        presentation: specAttentionRecordPresentationSchema.parse({
          state: history ? "history" : "current",
          attentionActive: !history && row.disposition === "proposed",
          lastMutation: latestMutationByRecordId.get(row.id) ?? null,
          humanCapability,
        }),
        currentDraftCitations:
          draft === null
            ? null
            : {
                revisionId: draft.revision.id,
                citationVersion: draft.revision.citationVersion,
                citationHash: draft.revision.citationHash,
                citations: draft.assumptionCitations.filter(
                  (citation) => citation.assumptionId === row.id,
                ),
              },
      };
    },
  );

  const currentQuestions = questionProjections
    .filter(({ presentation }) => presentation.state === "current")
    .sort(
      (left, right) =>
        Number(left.row.status !== "open") -
          Number(right.row.status !== "open") ||
        left.row.number - right.row.number,
    );
  const dispositionOrder = new Map([
    ["proposed", 0],
    ["confirmed", 1],
    ["rejected", 2],
    ["deferred", 3],
  ]);
  const currentAssumptions = assumptionProjections
    .filter(({ presentation }) => presentation.state === "current")
    .sort(
      (left, right) =>
        (dispositionOrder.get(left.row.disposition) ?? 4) -
          (dispositionOrder.get(right.row.disposition) ?? 4) ||
        left.row.number - right.row.number,
    );
  const history = [
    ...questionProjections
      .filter(({ presentation }) => presentation.state === "history")
      .map((projection) => ({ kind: "question" as const, ...projection })),
    ...assumptionProjections
      .filter(({ presentation }) => presentation.state === "history")
      .map((projection) => ({ kind: "assumption" as const, ...projection })),
  ].sort(
    (left, right) =>
      right.row.updated_at.localeCompare(left.row.updated_at) ||
      left.row.number - right.row.number,
  );

  return { currentQuestions, currentAssumptions, history };
}
