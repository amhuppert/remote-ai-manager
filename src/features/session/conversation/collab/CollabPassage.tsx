"use client";

import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  CollaborationAgent,
  CollaborationArtifact,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationFlowAgent,
  CollaborationInitialDraftOutput,
  CollaborationOpenConflictsOutput,
  CollaborationProposedChangesOutput,
  CollaborationReference,
  CollaborationResolutionDecisionOutput,
} from "@/lib/workflows/collaboration/types";
import CollabInitialDraftCard from "@/features/session/conversation/collab/CollabInitialDraftCard";
import CollabCrossReviewCard from "@/features/session/conversation/collab/CollabCrossReviewCard";
import CollabProposedChangesCard from "@/features/session/conversation/collab/CollabProposedChangesCard";
import CollabCounterProposalCard from "@/features/session/conversation/collab/CollabCounterProposalCard";
import CollabResolutionDecisionCard from "@/features/session/conversation/collab/CollabResolutionDecisionCard";
import CollabOpenConflictsCard from "@/features/session/conversation/collab/CollabOpenConflictsCard";
import CollabFinalAnswerMessage from "@/features/session/conversation/collab/CollabFinalAnswerMessage";
import CollabPhaseStrip, {
  type CollabPhaseStripPhase,
  type CollabPhaseVerdict,
} from "@/features/session/conversation/collab/CollabPhaseStrip";
import CollabConnector, {
  type CollabConnectorAnchor,
} from "@/features/session/conversation/collab/CollabConnector";
import CollabPassageControls from "@/features/session/conversation/collab/CollabPassageControls";
import { CollabCardOrchestrationProvider } from "@/features/session/conversation/collab/CollabCollapsibleCard";
import type { CollabPassageStatus } from "@/features/session/conversation/collab/envelope-adapter";

interface CollabPauseHandlers {
  drafts: Record<string, string>;
  onDraftChange: (questionId: string, value: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

export interface CollabPassageProps {
  workflowId: string;
  primary: CollaborationAgent;
  status: CollabPassageStatus;
  artifacts: CollaborationArtifact[];
  pauseHandlers?: CollabPauseHandlers;
  submittedAnswers?: Record<string, string>;
  hideInlinePhaseStrip?: boolean;
  pinnedTopTarget?: HTMLElement | null;
  onStop?: () => void;
  onRefClick?: (ref: CollaborationReference) => void;
  errorSummary?: string;
}

interface NegotiationRound {
  round: number;
  proposed?: CollaborationProposedChangesOutput;
  counter?: CollaborationCounterProposalOutput;
  decision?: CollaborationResolutionDecisionOutput;
}

interface GroupedArtifacts {
  initialDrafts: CollaborationInitialDraftOutput[];
  crossReview?: CollaborationCrossReviewOutput;
  rounds: NegotiationRound[];
  openConflicts?: CollaborationOpenConflictsOutput;
  finalAnswer?: CollaborationFinalAnswerOutput;
}

export function flowAgentToBackend(
  flow: CollaborationFlowAgent,
  primary: CollaborationAgent,
): CollaborationAgent {
  if (flow === "agent_one") return primary;
  return primary === "claude" ? "codex" : "claude";
}

export function isCollabPassageTerminal(status: CollabPassageStatus): boolean {
  return (
    status === "converged" ||
    status === "unresolved" ||
    status === "user-stopped" ||
    status === "failed"
  );
}

export function groupCollabArtifacts(
  artifacts: CollaborationArtifact[],
): GroupedArtifacts {
  const initialDrafts: CollaborationInitialDraftOutput[] = [];
  let crossReview: CollaborationCrossReviewOutput | undefined;
  const rounds: NegotiationRound[] = [];
  let openConflicts: CollaborationOpenConflictsOutput | undefined;
  let finalAnswer: CollaborationFinalAnswerOutput | undefined;
  let pending: NegotiationRound | null = null;

  const ensureRound = (): NegotiationRound => {
    if (!pending) pending = { round: rounds.length + 1 };
    return pending;
  };
  const closeRound = (): void => {
    if (pending) {
      rounds.push(pending);
      pending = null;
    }
  };

  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "initial_draft":
        initialDrafts.push(artifact);
        break;
      case "cross_review":
        crossReview = artifact;
        break;
      case "proposed_changes": {
        const round = ensureRound();
        round.proposed = artifact;
        break;
      }
      case "counter_proposal": {
        const round = ensureRound();
        round.counter = artifact;
        break;
      }
      case "resolution_decision": {
        const round = ensureRound();
        round.decision = artifact;
        closeRound();
        break;
      }
      case "open_conflicts":
        openConflicts = artifact;
        break;
      case "final_answer":
        finalAnswer = artifact;
        break;
    }
  }
  closeRound();

  return { initialDrafts, crossReview, rounds, openConflicts, finalAnswer };
}

export function trajectoryThroughRound(
  artifacts: CollaborationArtifact[],
  roundNumber: number,
): number[] {
  const series: number[] = [];
  let currentRound = 0;
  for (const a of artifacts) {
    if (a.kind === "counter_proposal") {
      currentRound += 1;
      if (currentRound > roundNumber) break;
      series.push(a.disagree.length);
    }
  }
  return series;
}

function verdictFor(
  status: CollabPassageStatus,
): CollabPhaseVerdict | undefined {
  if (status === "converged") return "converged";
  if (status === "paused") return "ask_user";
  if (status === "failed") return "failed";
  if (status === "user-stopped") return "user_stopped";
  return undefined;
}

export function buildPhases(
  grouped: GroupedArtifacts,
  status: CollabPassageStatus,
): CollabPhaseStripPhase[] {
  const phases: CollabPhaseStripPhase[] = [];
  const isTerminal = isCollabPassageTerminal(status);

  const draftStatus =
    grouped.initialDrafts.length >= 2
      ? "done"
      : grouped.initialDrafts.length >= 1
        ? "active"
        : status === "drafting"
          ? "active"
          : "pending";
  phases.push({ kind: { kind: "initial_draft" }, status: draftStatus });

  const crossStatus = grouped.crossReview
    ? "done"
    : grouped.initialDrafts.length >= 2 && status !== "drafting"
      ? "active"
      : "pending";
  phases.push({ kind: { kind: "cross_review" }, status: crossStatus });

  for (const round of grouped.rounds) {
    const roundStatus = round.decision
      ? "done"
      : round.proposed || round.counter
        ? "active"
        : "pending";
    phases.push({
      kind: { kind: "negotiation", round: round.round },
      status: roundStatus,
    });
  }

  if (grouped.openConflicts) {
    phases.push({
      kind: { kind: "open_conflicts" },
      status: status === "paused" ? "active" : "done",
    });
  } else if (status === "paused") {
    phases.push({
      kind: { kind: "open_conflicts" },
      status: "active",
    });
  }
  if (grouped.finalAnswer) {
    phases.push({
      kind: { kind: "final_answer" },
      status: "done",
    });
  } else if (status === "failed") {
    phases.push({ kind: { kind: "failed" }, status: "done" });
  }

  if (!isTerminal && phases.every((phase) => phase.status === "done")) {
    const last = phases[phases.length - 1];
    if (last) last.status = "active";
  }

  if (status === "failed") {
    for (const phase of phases) {
      if (phase.status === "active") phase.status = "pending";
    }
  }

  return phases;
}

function findPrimaryDraft(
  drafts: CollaborationInitialDraftOutput[],
): CollaborationInitialDraftOutput | undefined {
  return drafts.find((d) => d.agent === "agent_one");
}

function findSecondaryDraft(
  drafts: CollaborationInitialDraftOutput[],
): CollaborationInitialDraftOutput | undefined {
  return drafts.find((d) => d.agent === "agent_two");
}

function findLatestNonFinalArtifact(
  artifacts: CollaborationArtifact[],
): CollaborationArtifact | undefined {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const a = artifacts[i];
    if (a && a.kind !== "final_answer") return a;
  }
  return undefined;
}

const PULSE_DURATION_MS = 1500;
const PULSE_SCROLL_DELAY_MS = 500;

function CardHost({
  cardId,
  lane,
  children,
}: {
  cardId: string;
  lane: CollabConnectorAnchor;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="collab-card-host" data-card-id={cardId} data-lane={lane}>
      {children}
    </div>
  );
}

function PassageRow({
  children,
  rowKind,
}: {
  children: ReactNode;
  rowKind?: string;
}): React.JSX.Element {
  return (
    <div className="collab-passage-row" data-row-kind={rowKind}>
      {children}
    </div>
  );
}

interface CardEntry {
  id: string;
  lane: CollabConnectorAnchor;
  parallelGroup?: string;
  sourceLaneOverride?: CollabConnectorAnchor;
  render: () => React.JSX.Element;
}

interface ConnectorEntry {
  from: CollabConnectorAnchor;
  to: CollabConnectorAnchor;
  afterCardId: string;
  beforeCardId: string;
}

interface BuiltTimeline {
  cards: CardEntry[];
  rows: Array<{ rowId: string; cardIds: string[]; rowKind: string }>;
  connectorsByBeforeId: Map<string, ConnectorEntry>;
}

function buildTimeline(
  grouped: GroupedArtifacts,
  primary: CollaborationAgent,
  artifacts: CollaborationArtifact[],
  latestNonFinal: CollaborationArtifact | undefined,
  pauseHandlers: CollabPauseHandlers | undefined,
  submittedAnswers: Record<string, string> | undefined,
  onRefClick: ((ref: CollaborationReference) => void) | undefined,
): BuiltTimeline {
  const cards: CardEntry[] = [];
  const rows: Array<{ rowId: string; cardIds: string[]; rowKind: string }> = [];
  const isLatest = (artifact: CollaborationArtifact): boolean =>
    latestNonFinal !== undefined && latestNonFinal === artifact;

  const primaryDraft = findPrimaryDraft(grouped.initialDrafts);
  const secondaryDraft = findSecondaryDraft(grouped.initialDrafts);

  if (primaryDraft || secondaryDraft) {
    const rowCardIds: string[] = [];
    if (primaryDraft) {
      const id = "draft-primary";
      rowCardIds.push(id);
      cards.push({
        id,
        lane: "left",
        parallelGroup: "drafts",
        render: () => (
          <CollabInitialDraftCard
            agent={flowAgentToBackend(primaryDraft.agent, primary)}
            isPrimary
            narrative={primaryDraft.narrative}
            supporting={primaryDraft.supporting}
            assumptions={primaryDraft.assumptions}
            keyClaims={primaryDraft.keyClaims}
            defaultOpen={isLatest(primaryDraft)}
            onRefClick={onRefClick}
          />
        ),
      });
    }
    if (secondaryDraft) {
      const id = "draft-secondary";
      rowCardIds.push(id);
      cards.push({
        id,
        lane: "right",
        parallelGroup: "drafts",
        render: () => (
          <CollabInitialDraftCard
            agent={flowAgentToBackend(secondaryDraft.agent, primary)}
            isPrimary={false}
            narrative={secondaryDraft.narrative}
            supporting={secondaryDraft.supporting}
            assumptions={secondaryDraft.assumptions}
            keyClaims={secondaryDraft.keyClaims}
            defaultOpen={isLatest(secondaryDraft)}
            onRefClick={onRefClick}
          />
        ),
      });
    }
    rows.push({ rowId: "drafts", cardIds: rowCardIds, rowKind: "drafts" });
  }

  if (grouped.crossReview) {
    const cr = grouped.crossReview;
    const reviewerAgent = flowAgentToBackend(cr.agent, primary);
    const targetAgent = flowAgentToBackend(cr.targetAgent, primary);
    const lane: CollabConnectorAnchor =
      cr.agent === "agent_one" ? "left" : "right";
    const sourceLaneOverride: CollabConnectorAnchor =
      cr.targetAgent === "agent_one" ? "left" : "right";
    const id = "cross-review";
    cards.push({
      id,
      lane,
      sourceLaneOverride,
      render: () => (
        <CollabCrossReviewCard
          reviewerAgent={reviewerAgent}
          targetAgent={targetAgent}
          narrative={cr.narrative}
          supporting={cr.supporting}
          agree={cr.agree}
          disagree={cr.disagree}
          reviseSelf={cr.reviseSelf}
          defaultOpen={isLatest(cr)}
          onRefClick={onRefClick}
        />
      ),
    });
    rows.push({
      rowId: "cross-review",
      cardIds: [id],
      rowKind: "cross-review",
    });
  }

  for (const round of grouped.rounds) {
    if (round.proposed) {
      const proposed = round.proposed;
      const id = `round-${round.round}-proposed`;
      cards.push({
        id,
        lane: "left",
        render: () => (
          <CollabProposedChangesCard
            fromAgent={flowAgentToBackend(proposed.agent, primary)}
            round={round.round}
            narrative={proposed.narrative}
            acceptedFromAgentTwoDraft={proposed.acceptedFromAgentTwoDraft}
            proposedChanges={proposed.proposedChanges}
            remainingDisagreements={proposed.remainingDisagreements}
            supporting={proposed.supporting}
            defaultOpen={isLatest(proposed)}
            onRefClick={onRefClick}
          />
        ),
      });
      rows.push({
        rowId: `round-${round.round}-proposed`,
        cardIds: [id],
        rowKind: "proposed",
      });
    }
    if (round.counter) {
      const counter = round.counter;
      const id = `round-${round.round}-counter`;
      cards.push({
        id,
        lane: "right",
        render: () => (
          <CollabCounterProposalCard
            fromAgent={flowAgentToBackend(counter.agent, primary)}
            round={round.round}
            narrative={counter.narrative}
            acceptedProposedChangeIds={counter.acceptedProposedChangeIds}
            rejectedProposedChangeIds={counter.rejectedProposedChangeIds}
            alternativeChanges={counter.alternativeChanges}
            agree={counter.agree}
            disagree={counter.disagree}
            supporting={counter.supporting}
            defaultOpen={isLatest(counter)}
            onRefClick={onRefClick}
          />
        ),
      });
      rows.push({
        rowId: `round-${round.round}-counter`,
        cardIds: [id],
        rowKind: "counter",
      });
    }
    if (round.decision) {
      const decision = round.decision;
      const id = `round-${round.round}-decision`;
      cards.push({
        id,
        lane: "full",
        render: () => (
          <CollabResolutionDecisionCard
            agent={flowAgentToBackend(decision.agent, primary)}
            round={round.round}
            agreementReached={decision.agreementReached}
            nextAction={decision.nextAction}
            acceptedPoints={decision.acceptedPoints}
            resolvedDisagreements={decision.resolvedDisagreements}
            remainingDisagreements={decision.remainingDisagreements}
            userQuestions={decision.userQuestions}
            rationale={decision.rationale}
            trajectory={trajectoryThroughRound(artifacts, round.round)}
            defaultOpen={isLatest(decision)}
            onRefClick={onRefClick}
          />
        ),
      });
      rows.push({
        rowId: `round-${round.round}-decision`,
        cardIds: [id],
        rowKind: "decision",
      });
    }
  }

  if (grouped.openConflicts) {
    const oc = grouped.openConflicts;
    const id = "open-conflicts";
    cards.push({
      id,
      lane: "full",
      render: () =>
        pauseHandlers ? (
          <CollabOpenConflictsCard
            mode="awaiting"
            disagreements={oc.disagreements}
            questions={oc.questions}
            drafts={pauseHandlers.drafts}
            onDraftChange={pauseHandlers.onDraftChange}
            onSubmit={pauseHandlers.onSubmit}
            isSubmitting={pauseHandlers.isSubmitting}
          />
        ) : (
          <CollabOpenConflictsCard
            mode="answered"
            disagreements={oc.disagreements}
            questions={oc.questions}
            submittedAnswers={submittedAnswers ?? {}}
          />
        ),
    });
    rows.push({
      rowId: "open-conflicts",
      cardIds: [id],
      rowKind: "open-conflicts",
    });
  }

  if (grouped.finalAnswer) {
    const fa = grouped.finalAnswer;
    const id = "final-answer";
    cards.push({
      id,
      lane: "full",
      render: () => (
        <CollabFinalAnswerMessage
          agent={flowAgentToBackend(fa.agent, primary)}
          answer={fa.answer}
        />
      ),
    });
    rows.push({
      rowId: "final-answer",
      cardIds: [id],
      rowKind: "final-answer",
    });
  }

  const connectorsByBeforeId = new Map<string, ConnectorEntry>();
  for (let i = 1; i < rows.length; i++) {
    const prevRow = rows[i - 1]!;
    const row = rows[i]!;
    const prevExitCardId =
      prevRow.cardIds[prevRow.cardIds.length - 1] ?? prevRow.cardIds[0]!;
    const targetCardId = row.cardIds[0]!;
    const sourceCard = cards.find((c) => c.id === prevExitCardId);
    const targetCard = cards.find((c) => c.id === targetCardId);
    if (!sourceCard || !targetCard) continue;
    const fromLane: CollabConnectorAnchor =
      targetCard.sourceLaneOverride ??
      (prevRow.cardIds.length > 1
        ? targetCard.lane === "right"
          ? "right"
          : "left"
        : sourceCard.lane);
    connectorsByBeforeId.set(targetCardId, {
      from: fromLane,
      to: targetCard.lane,
      afterCardId: prevExitCardId,
      beforeCardId: targetCardId,
    });
  }

  return { cards, rows, connectorsByBeforeId };
}

export default function CollabPassage({
  workflowId,
  primary,
  status,
  artifacts,
  pauseHandlers,
  submittedAnswers,
  hideInlinePhaseStrip,
  pinnedTopTarget,
  onStop,
  onRefClick,
  errorSummary,
}: CollabPassageProps): React.JSX.Element {
  const grouped = groupCollabArtifacts(artifacts);
  const isTerminal = isCollabPassageTerminal(status);
  const stopHandler = !isTerminal ? onStop : undefined;
  const phases = buildPhases(grouped, status);
  const verdict = verdictFor(status);

  const latestNonFinal = grouped.finalAnswer
    ? undefined
    : findLatestNonFinalArtifact(artifacts);

  const timeline = useMemo(
    () =>
      buildTimeline(
        grouped,
        primary,
        artifacts,
        latestNonFinal,
        pauseHandlers,
        submittedAnswers,
        onRefClick,
      ),
    [
      grouped,
      primary,
      artifacts,
      latestNonFinal,
      pauseHandlers,
      submittedAnswers,
      onRefClick,
    ],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [navIndex, setNavIndex] = useState<number>(0);
  const [forceState, setForceState] = useState<"open" | "closed" | null>(null);
  const [forceTick, setForceTick] = useState<number>(0);

  const navigateTo = useCallback(
    (idx: number) => {
      const total = timeline.cards.length;
      if (total === 0) return;
      const clamped = Math.max(0, Math.min(total - 1, idx));
      const target = timeline.cards[clamped];
      if (!target) return;
      const container = containerRef.current;
      if (!container) {
        setNavIndex(clamped);
        return;
      }
      const targetEl = container.querySelector<HTMLElement>(
        `[data-card-id="${target.id}"]`,
      );
      if (!targetEl) {
        setNavIndex(clamped);
        return;
      }
      const currentCard = timeline.cards[navIndex];
      const currentEl = currentCard
        ? container.querySelector<HTMLElement>(
            `[data-card-id="${currentCard.id}"]`,
          )
        : null;
      const sameRow =
        currentEl !== null &&
        currentEl !== targetEl &&
        Math.abs(
          currentEl.getBoundingClientRect().top -
            targetEl.getBoundingClientRect().top,
        ) < 4;
      const willScroll = !sameRow;
      if (willScroll) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      const triggerPulse = (): void => {
        targetEl.setAttribute("data-pulse", "true");
        window.setTimeout(() => {
          targetEl.removeAttribute("data-pulse");
        }, PULSE_DURATION_MS);
      };
      if (willScroll) {
        window.setTimeout(triggerPulse, PULSE_SCROLL_DELAY_MS);
      } else {
        triggerPulse();
      }
      setNavIndex(clamped);
    },
    [timeline, navIndex],
  );

  const onPrev = useCallback(
    () => navigateTo(navIndex - 1),
    [navIndex, navigateTo],
  );
  const onNext = useCallback(
    () => navigateTo(navIndex + 1),
    [navIndex, navigateTo],
  );
  const onExpandAll = useCallback(() => {
    setForceState("open");
    setForceTick((t) => t + 1);
  }, []);
  const onCollapseAll = useCallback(() => {
    setForceState("closed");
    setForceTick((t) => t + 1);
  }, []);

  const renderRow = (rowIdx: number): React.JSX.Element | null => {
    const row = timeline.rows[rowIdx];
    if (!row) return null;
    const rowCards = row.cardIds
      .map((id) => timeline.cards.find((c) => c.id === id))
      .filter((c): c is CardEntry => c !== undefined);
    return (
      <PassageRow rowKind={row.rowKind}>
        {rowCards.map((card) => (
          <CardHost key={card.id} cardId={card.id} lane={card.lane}>
            {card.render()}
          </CardHost>
        ))}
      </PassageRow>
    );
  };

  const renderConnectorBefore = (cardId: string): React.JSX.Element | null => {
    const conn = timeline.connectorsByBeforeId.get(cardId);
    if (!conn) return null;
    return <CollabConnector from={conn.from} to={conn.to} />;
  };

  const showBand = pinnedTopTarget != null || !hideInlinePhaseStrip;
  const bandElement = showBand ? (
    <div className="collab-passage-band" data-band="phase-strip">
      <CollabPhaseStrip
        phases={phases}
        verdict={verdict}
        onStop={stopHandler}
      />
      <CollabPassageControls
        total={timeline.cards.length}
        currentIndex={navIndex}
        onPrev={onPrev}
        onNext={onNext}
        onExpandAll={onExpandAll}
        onCollapseAll={onCollapseAll}
      />
    </div>
  ) : null;

  const showErrorBanner = status === "failed" && errorSummary !== undefined;

  return (
    <article
      className="collab-passage"
      data-workflow-id={workflowId}
      data-status={status}
      data-primary={primary}
      aria-label="Collaboration passage"
    >
      {pinnedTopTarget && bandElement
        ? createPortal(bandElement, pinnedTopTarget)
        : bandElement}

      {showErrorBanner ? (
        <div
          className="collab-passage-error-banner"
          role="alert"
          aria-label="Collaboration failure"
        >
          <span className="collab-passage-error-banner-label">
            Collaboration failed
          </span>
          <span className="collab-passage-error-banner-message">
            {errorSummary}
          </span>
        </div>
      ) : null}

      <div className="collab-passage-timeline" ref={containerRef}>
        <CollabCardOrchestrationProvider
          forceState={forceState}
          tick={forceTick}
        >
          {renderTimelineSections(timeline, renderRow, renderConnectorBefore)}
        </CollabCardOrchestrationProvider>
      </div>
    </article>
  );
}

function renderTimelineSections(
  timeline: BuiltTimeline,
  renderRow: (rowIdx: number) => React.JSX.Element | null,
  renderConnectorBefore: (cardId: string) => React.JSX.Element | null,
): React.JSX.Element {
  const sectionsByKind = new Map<string, number[]>();
  timeline.rows.forEach((row, idx) => {
    let sectionKey: string;
    if (row.rowKind === "drafts") sectionKey = "initial_draft";
    else if (row.rowKind === "cross-review") sectionKey = "cross_review";
    else if (
      row.rowKind === "proposed" ||
      row.rowKind === "counter" ||
      row.rowKind === "decision"
    ) {
      sectionKey = `negotiation:${row.rowId.split("-")[1]}`;
    } else if (row.rowKind === "open-conflicts") sectionKey = "open_conflicts";
    else if (row.rowKind === "final-answer") sectionKey = "final_answer";
    else sectionKey = row.rowKind;
    const existing = sectionsByKind.get(sectionKey) ?? [];
    existing.push(idx);
    sectionsByKind.set(sectionKey, existing);
  });

  const ordered: Array<{ sectionKey: string; rowIdxs: number[] }> = [];
  const seen = new Set<string>();
  timeline.rows.forEach((row, idx) => {
    let sectionKey: string;
    if (row.rowKind === "drafts") sectionKey = "initial_draft";
    else if (row.rowKind === "cross-review") sectionKey = "cross_review";
    else if (
      row.rowKind === "proposed" ||
      row.rowKind === "counter" ||
      row.rowKind === "decision"
    ) {
      sectionKey = `negotiation:${row.rowId.split("-")[1]}`;
    } else if (row.rowKind === "open-conflicts") sectionKey = "open_conflicts";
    else if (row.rowKind === "final-answer") sectionKey = "final_answer";
    else sectionKey = row.rowKind;
    if (seen.has(sectionKey)) return;
    seen.add(sectionKey);
    ordered.push({
      sectionKey,
      rowIdxs: sectionsByKind.get(sectionKey) ?? [idx],
    });
  });

  return (
    <>
      {ordered.map(({ sectionKey, rowIdxs }) => {
        const isNegotiation = sectionKey.startsWith("negotiation:");
        const round = isNegotiation
          ? Number(sectionKey.split(":")[1])
          : undefined;
        const dataSection = isNegotiation ? "negotiation" : sectionKey;
        const ariaLabel = sectionAriaLabel(sectionKey, round);
        return (
          <Fragment key={sectionKey}>
            <section
              className="collab-passage-section"
              data-section={dataSection}
              {...(round !== undefined ? { "data-round": round } : {})}
              aria-label={ariaLabel}
            >
              {rowIdxs.map((rowIdx, i) => {
                const row = timeline.rows[rowIdx]!;
                const firstCardId = row.cardIds[0]!;
                const connector =
                  i === 0
                    ? renderConnectorBefore(firstCardId)
                    : renderConnectorBefore(firstCardId);
                return (
                  <Fragment key={row.rowId}>
                    {connector}
                    {renderRow(rowIdx)}
                  </Fragment>
                );
              })}
            </section>
          </Fragment>
        );
      })}
    </>
  );
}

function sectionAriaLabel(sectionKey: string, round?: number): string {
  if (sectionKey === "initial_draft") return "Initial drafts";
  if (sectionKey === "cross_review") return "Cross-review";
  if (sectionKey.startsWith("negotiation:"))
    return `Negotiation round ${round}`;
  if (sectionKey === "open_conflicts") return "Open conflicts";
  if (sectionKey === "final_answer") return "Final answer";
  return sectionKey;
}
