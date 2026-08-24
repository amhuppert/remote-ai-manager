"use client";

import { createClientLogger } from "@/lib/logging/client-logger";
import type { SpecPhaseProjection } from "@/lib/specs/phase";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecAssumptionDisposition } from "@/lib/specs/schemas";
import {
  specAssumptionViewSchema,
  specQuestionViewSchema,
  type SpecAssumptionView,
  type SpecAttentionAuditEventView,
  type SpecDetailView,
  type SpecLintView,
  type SpecQuestionView,
} from "@/lib/specs/view-schemas";

import SpecAttentionRegister from "./SpecAttentionRegister";
import { importProvenance } from "./presentation";
import SpecReadOnlyNotice from "./SpecReadOnlyNotice";

const logger = createClientLogger("spec-studio-questions");

export interface AnswerQuestionPanelInput {
  questionId: string;
  recordVersion: number;
  answer: string;
}

export type AssumptionDispositionChoice = Extract<
  SpecAssumptionDisposition,
  "confirmed" | "rejected" | "deferred"
>;

export interface DisposeAssumptionPanelInput {
  assumptionId: string;
  recordVersion: number;
  citationVersion?: number;
  disposition: AssumptionDispositionChoice;
}

type AttentionHistoryEntry =
  | { kind: "question"; record: SpecQuestionView }
  | { kind: "assumption"; record: SpecAssumptionView };

const questionOrder: Record<SpecQuestionView["status"], number> = {
  open: 0,
  answered: 1,
  withdrawn: 2,
};

const assumptionOrder: Record<SpecAssumptionDisposition, number> = {
  proposed: 0,
  confirmed: 1,
  rejected: 2,
  deferred: 3,
  withdrawn: 4,
};

function byRecordNumber<T extends { number: number }>(
  left: T,
  right: T,
): number {
  return left.number - right.number;
}

function currentQuestions(
  questions: readonly SpecQuestionView[],
): SpecQuestionView[] {
  return questions
    .filter(({ presentation }) => presentation.state === "current")
    .sort(
      (left, right) =>
        questionOrder[left.status] - questionOrder[right.status] ||
        byRecordNumber(left, right),
    );
}

function currentAssumptions(
  assumptions: readonly SpecAssumptionView[],
): SpecAssumptionView[] {
  return assumptions
    .filter(({ presentation }) => presentation.state === "current")
    .sort(
      (left, right) =>
        assumptionOrder[left.disposition] -
          assumptionOrder[right.disposition] || byRecordNumber(left, right),
    );
}

function recordHistory(
  questions: readonly SpecQuestionView[],
  assumptions: readonly SpecAssumptionView[],
): AttentionHistoryEntry[] {
  return [
    ...questions
      .filter(({ presentation }) => presentation.state === "history")
      .map((record) => ({ kind: "question" as const, record })),
    ...assumptions
      .filter(({ presentation }) => presentation.state === "history")
      .map((record) => ({ kind: "assumption" as const, record })),
  ].sort(
    (left, right) =>
      right.record.updatedAt.localeCompare(left.record.updatedAt) ||
      left.record.handle.localeCompare(right.record.handle),
  );
}

function historyReasons(
  events: readonly SpecAttentionAuditEventView[],
): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const event of events) {
    if (event.kind !== "record" || event.payload.reason === undefined) continue;
    reasons[event.payload.recordId] = event.payload.reason;
  }
  return reasons;
}

export function blockingAssumptionIdsFromLint(
  assumptions: readonly SpecAssumptionView[],
  findings: SpecLintView["findings"],
): string[] {
  const blockingHandles = new Set(
    findings.flatMap((finding) => {
      if (
        finding.ruleId !== "9.8.rejected-cited-assumption" ||
        finding.severity !== "blocks_signoff"
      ) {
        return [];
      }
      return finding.message.match(/\bA[1-9]\d*\b/g) ?? [];
    }),
  );
  return assumptions
    .filter(({ handle }) => blockingHandles.has(handle))
    .map(({ id }) => id);
}

export function SpecQuestionsAssumptions({
  questions,
  assumptions,
  projectName,
  slug,
  revision,
  phase,
  elementHandlesById,
  importedAt = null,
  targetHandle = null,
  blockingAssumptionIds = [],
  historyReasonsById = {},
  showIntro = true,
  onAnswerQuestion,
  onDisposeAssumption,
}: {
  questions: readonly SpecQuestionView[];
  assumptions: readonly SpecAssumptionView[];
  projectName: string;
  slug: string;
  revision: number;
  phase: SpecPhaseProjection;
  elementHandlesById: ReadonlyMap<string, string>;
  importedAt?: string | null;
  targetHandle?: string | null;
  blockingAssumptionIds?: readonly string[];
  historyReasonsById?: Readonly<Record<string, string>>;
  showIntro?: boolean;
  onAnswerQuestion(input: AnswerQuestionPanelInput): Promise<void>;
  onDisposeAssumption(input: DisposeAssumptionPanelInput): Promise<void>;
}): React.JSX.Element {
  return (
    <SpecAttentionRegister
      projectName={projectName}
      slug={slug}
      revision={revision}
      phase={phase}
      questions={currentQuestions(questions)}
      assumptions={currentAssumptions(assumptions)}
      history={recordHistory(questions, assumptions)}
      elementHandlesById={elementHandlesById}
      blockingAssumptionIds={blockingAssumptionIds}
      historyReasonsById={historyReasonsById}
      importedAt={importedAt}
      targetHandle={targetHandle}
      showIntro={showIntro}
      onAnswerQuestion={onAnswerQuestion}
      onDisposeAssumption={onDisposeAssumption}
    />
  );
}

function elementHandleIndex(detail: SpecDetailView): Map<string, string> {
  const snapshot = detail.currentRevision ?? detail.currentApprovedRevision;
  const handles = new Map<string, string>();
  if (snapshot === null) return handles;
  for (const entry of snapshot.elements) {
    const number = entry.element.number;
    if (number === null) continue;
    switch (entry.version.payload.kind) {
      case "requirement":
        handles.set(entry.element.id, `R${number}`);
        break;
      case "decision":
        handles.set(entry.element.id, `D${number}`);
        break;
      case "task":
        handles.set(entry.element.id, `T${number}`);
        break;
      default:
        break;
    }
  }
  for (const entry of snapshot.elements) {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      continue;
    }
    const parent = handles.get(entry.element.parentElementId);
    if (parent === undefined) continue;
    handles.set(entry.element.id, `${parent}.${entry.element.number}`);
  }
  return handles;
}

export default function SpecQuestionsAssumptionsPanel({
  detail,
  projectName,
  targetHandle = null,
  blockingAssumptionIds = [],
}: {
  detail: SpecDetailView;
  projectName: string;
  targetHandle?: string | null;
  blockingAssumptionIds?: readonly string[];
}): React.JSX.Element {
  const answerQuestion = useSpecActionMutation<
    AnswerQuestionPanelInput,
    SpecQuestionView
  >(projectName, detail.spec.slug, "answer-question", specQuestionViewSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-attention-changed"],
  });
  const disposeAssumption = useSpecActionMutation<
    DisposeAssumptionPanelInput,
    SpecAssumptionView
  >(
    projectName,
    detail.spec.slug,
    "dispose-assumption",
    specAssumptionViewSchema,
    { specId: detail.spec.id, eventTypes: ["spec-attention-changed"] },
  );
  const revision = Math.max(
    1,
    ...detail.revisions.map((candidate) => candidate.number),
  );
  const readOnly = detail.spec.abandonedAt !== null;

  async function answer(input: AnswerQuestionPanelInput): Promise<void> {
    try {
      await answerQuestion.mutateAsync(input);
      logger.info("spec_studio.qa_action.completed", {
        action: "answer-question",
        specId: detail.spec.id,
        questionId: input.questionId,
        recordVersion: input.recordVersion,
      });
    } catch (error) {
      logger.warn("spec_studio.qa_action.failed", {
        action: "answer-question",
        specId: detail.spec.id,
        questionId: input.questionId,
        recordVersion: input.recordVersion,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function dispose(input: DisposeAssumptionPanelInput): Promise<void> {
    try {
      await disposeAssumption.mutateAsync(input);
      logger.info("spec_studio.qa_action.completed", {
        action: "dispose-assumption",
        specId: detail.spec.id,
        assumptionId: input.assumptionId,
        recordVersion: input.recordVersion,
        citationVersion: input.citationVersion,
        disposition: input.disposition,
      });
    } catch (error) {
      logger.warn("spec_studio.qa_action.failed", {
        action: "dispose-assumption",
        specId: detail.spec.id,
        assumptionId: input.assumptionId,
        recordVersion: input.recordVersion,
        citationVersion: input.citationVersion,
        disposition: input.disposition,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return (
    <div className="grid gap-lg">
      {readOnly ? (
        <SpecReadOnlyNotice reason={detail.spec.abandonedReason} />
      ) : null}
      <SpecQuestionsAssumptions
        questions={detail.questions}
        assumptions={detail.assumptions}
        projectName={projectName}
        slug={detail.spec.slug}
        revision={revision}
        phase={detail.status.phase}
        elementHandlesById={elementHandleIndex(detail)}
        importedAt={importProvenance(detail.gateAdmissions)?.at ?? null}
        targetHandle={targetHandle}
        blockingAssumptionIds={blockingAssumptionIds}
        historyReasonsById={historyReasons(detail.attentionAuditEvents)}
        showIntro={false}
        onAnswerQuestion={answer}
        onDisposeAssumption={dispose}
      />
    </div>
  );
}
