import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { EvidenceKind, ValidationStrategy } from "./schemas";

export type EvidenceSourceEvent =
  | "graph-workflow-lane-commit"
  | "graph-workflow-validation-result";

export interface EvidenceProducerDefinition {
  readonly kind: EvidenceKind;
  readonly sourceEvent: EvidenceSourceEvent;
  readonly requiresStrategyDeclaration: boolean;
  readonly detail: string;
}

export const EVIDENCE_PRODUCERS = [
  {
    kind: "commit",
    sourceEvent: "graph-workflow-lane-commit",
    requiresStrategyDeclaration: false,
    detail:
      "the lane's commit event mints commit evidence for every criterion its context owns",
  },
  {
    kind: "test_run",
    sourceEvent: "graph-workflow-validation-result",
    requiresStrategyDeclaration: true,
    detail:
      "minted from the same validation event as validator_verdict, under the same rule, and only because this criterion's own strategy declares test_run — no test runner reports it independently",
  },
  {
    kind: "validator_verdict",
    sourceEvent: "graph-workflow-validation-result",
    requiresStrategyDeclaration: false,
    detail:
      "every validation-result event for this context mints it, a failing or superseded one included; only a passing verdict sealed by the following lane commit ALSO becomes admissible proof, so evidence existing is not the same as the criterion being proved",
  },
] as const satisfies readonly EvidenceProducerDefinition[];

export function evidenceProducerFor(
  kind: string,
): EvidenceProducerDefinition | null {
  return EVIDENCE_PRODUCERS.find((entry) => entry.kind === kind) ?? null;
}

export function isEvidenceSourceEvent(
  event: GraphWorkflowSSEEvent,
): event is Extract<GraphWorkflowSSEEvent, { type: EvidenceSourceEvent }> {
  return EVIDENCE_PRODUCERS.some(
    ({ sourceEvent }) => sourceEvent === event.type,
  );
}

export function evidenceKindsForSourceEvent(
  sourceEvent: EvidenceSourceEvent,
  strategy: ValidationStrategy | undefined,
): EvidenceKind[] {
  return EVIDENCE_PRODUCERS.filter(
    (entry) =>
      entry.sourceEvent === sourceEvent &&
      (!entry.requiresStrategyDeclaration ||
        strategy?.kinds.includes(entry.kind) === true),
  ).map((entry) => entry.kind);
}

export function evidenceKindsForValidationEvent(
  strategy: ValidationStrategy | undefined,
): EvidenceKind[] {
  return evidenceKindsForSourceEvent(
    "graph-workflow-validation-result",
    strategy,
  );
}
