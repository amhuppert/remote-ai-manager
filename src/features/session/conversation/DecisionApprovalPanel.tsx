"use client";

import { useRef, useState } from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";
import { useResolveDecisionsMutation } from "@/lib/session-alignment/mutations";
import type {
  DecisionProposalBatch,
  DecisionResolution,
} from "@/lib/session-alignment/schemas";

interface ProposalResolution {
  approve: boolean;
  feedback: string;
}

const choiceBase =
  "inline-flex cursor-pointer items-center gap-xs rounded-md border border-solid px-[12px] py-[6px] font-mono text-[0.72rem] transition-all duration-150 ease-[ease] disabled:cursor-not-allowed disabled:opacity-[0.45]";

function choiceClass(kind: "approve" | "reject", selected: boolean): string {
  if (kind === "approve") {
    return cn(
      choiceBase,
      selected
        ? "border-cyan bg-cyan font-semibold text-text-inverse"
        : "border-border-default bg-transparent text-text-secondary hover:border-cyan hover:text-cyan",
    );
  }
  return cn(
    choiceBase,
    selected
      ? "border-[var(--cc-red-border)] bg-transparent font-semibold text-red"
      : "border-border-default bg-transparent text-text-secondary hover:border-red-dim hover:text-red",
  );
}

const feedbackClass =
  "min-h-[60px] w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[8px] font-mono text-[0.78rem] leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary focus:border-red-dim focus:shadow-[0_0_0_2px_var(--red-glow)]";

export interface DecisionApprovalPanelViewProps {
  batch: DecisionProposalBatch;
  isSubmitting: boolean;
  onSubmit(resolutions: DecisionResolution[]): void;
}

/**
 * Bulk decision-approval surface (R5.2) reusing the AskUserQuestion option/note
 * shape: each proposed decision defaults to approve and can be flipped to
 * reject-with-feedback. A single submit resolves the whole batch — only approved
 * decisions are folded into the charter; rejections route feedback to the agent.
 */
export function DecisionApprovalPanelView({
  batch,
  isSubmitting,
  onSubmit,
}: DecisionApprovalPanelViewProps): React.JSX.Element {
  const [resolutions, setResolutions] = useState<
    Record<string, ProposalResolution>
  >(() =>
    Object.fromEntries(
      batch.proposals.map((p) => [p.id, { approve: true, feedback: "" }]),
    ),
  );
  const feedbackActionRefs = useRef<
    Map<string, MultilineInputActionHandle | null>
  >(new Map());

  const setApprove = (id: string, approve: boolean) =>
    setResolutions((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { approve: true, feedback: "" }), approve },
    }));

  const setFeedback = (id: string, feedback: string) =>
    setResolutions((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { approve: true, feedback: "" }), feedback },
    }));

  const handleSubmit = (feedbackOverride?: { id: string; value: string }) => {
    if (isSubmitting) return;
    const payload: DecisionResolution[] = batch.proposals.map((p) => {
      const r = resolutions[p.id] ?? { approve: true, feedback: "" };
      if (r.approve) return { proposalId: p.id, approve: true };
      const feedback =
        feedbackOverride?.id === p.id
          ? feedbackOverride.value.trim()
          : r.feedback.trim();
      return feedback
        ? { proposalId: p.id, approve: false, feedback }
        : { proposalId: p.id, approve: false };
    });
    onSubmit(payload);
  };

  return (
    <div
      data-testid="decision-approval-panel"
      className="flex shrink-0 flex-col gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-lg py-md"
    >
      <div className="flex items-center gap-md">
        <span
          className="size-[7px] shrink-0 rounded-full bg-cyan shadow-[0_0_8px_var(--color-cyan-glow)]"
          aria-hidden="true"
        />
        <div className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-cyan uppercase">
          Decisions proposed
        </div>
        <span className="ml-auto font-mono text-[0.66rem] text-text-tertiary">
          {batch.proposals.length} to review
        </span>
      </div>

      <ul className="flex list-none flex-col gap-sm p-0">
        {batch.proposals.map((p) => {
          const r = resolutions[p.id] ?? { approve: true, feedback: "" };
          return (
            <li
              key={p.id}
              data-testid="decision-proposal"
              className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base px-md py-[11px]"
            >
              <p className="m-0 font-mono text-[0.82rem] leading-[1.4] font-semibold text-text-primary">
                {p.statement}
              </p>
              {p.rationale && (
                <p className="m-0 font-mono text-[0.74rem] leading-[1.45] text-text-tertiary">
                  {p.rationale}
                </p>
              )}
              {p.context && (
                <p className="m-0 font-mono text-[0.74rem] leading-[1.45] text-text-tertiary">
                  {p.context}
                </p>
              )}
              <div className="flex items-center gap-sm">
                <button
                  type="button"
                  aria-pressed={r.approve}
                  onClick={() => setApprove(p.id, true)}
                  disabled={isSubmitting}
                  className={choiceClass("approve", r.approve)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  aria-pressed={!r.approve}
                  onClick={() => setApprove(p.id, false)}
                  disabled={isSubmitting}
                  className={choiceClass("reject", !r.approve)}
                >
                  Reject
                </button>
              </div>
              {!r.approve && (
                <MultilineInput
                  aria-label={`Reason for rejecting: ${p.statement}`}
                  value={r.feedback}
                  onValueChange={(value) => setFeedback(p.id, value)}
                  onPrimaryAction={(value) => handleSubmit({ id: p.id, value })}
                  actionRef={(handle) => {
                    if (handle) feedbackActionRefs.current.set(p.id, handle);
                    else feedbackActionRefs.current.delete(p.id);
                  }}
                  disabled={isSubmitting}
                  placeholder="Explain what needs to change… (optional)"
                  className={feedbackClass}
                  rows={2}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-sm">
        <Button
          variant="primary"
          size="sm"
          touch
          onClick={() =>
            runMultilinePrimaryAction(
              feedbackActionRefs.current.values(),
              handleSubmit,
            )
          }
          loading={isSubmitting}
        >
          {isSubmitting ? "Submitting…" : "Submit decisions"}
        </Button>
        <span className="font-mono text-[0.66rem] text-text-tertiary">
          Approved decisions fold into the charter; rejections send feedback
          back to the agent.
        </span>
      </div>
    </div>
  );
}

interface DecisionApprovalPanelProps {
  projectName: string;
  sessionName: string;
  batch: DecisionProposalBatch;
}

export default function DecisionApprovalPanel({
  projectName,
  sessionName,
  batch,
}: DecisionApprovalPanelProps): React.JSX.Element {
  const resolve = useResolveDecisionsMutation(projectName, sessionName);

  return (
    <DecisionApprovalPanelView
      batch={batch}
      isSubmitting={resolve.isPending}
      onSubmit={(resolutions) =>
        resolve.mutate({ batchId: batch.batchId, resolutions })
      }
    />
  );
}
