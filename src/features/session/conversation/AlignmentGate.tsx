"use client";

import ApproveCharterBanner from "@/features/session/conversation/ApproveCharterBanner";
import DecisionApprovalPanel from "@/features/session/conversation/DecisionApprovalPanel";
import { useAlignmentStateQuery } from "@/lib/session-alignment/queries";

interface AlignmentGateProps {
  projectName: string;
  sessionName: string;
  /** Read-only / finished sessions suppress the approval affordances. */
  disabled?: boolean;
}

/**
 * The conversation-level alignment gate (R4.1, R5.2). Surfaces the Approve-Charter
 * banner while a `/align` draft is pending and the decision-approval panel while a
 * proposal batch is pending — both sourced from the live alignment state, so any
 * conversation in the session can resolve them.
 */
export default function AlignmentGate({
  projectName,
  sessionName,
  disabled = false,
}: AlignmentGateProps): React.JSX.Element | null {
  const { data: state } = useAlignmentStateQuery(projectName, sessionName);

  if (disabled || !state) return null;

  const batch = state.pendingProposals[0];
  if (!state.draft && !batch) return null;

  return (
    <>
      {state.draft && (
        <ApproveCharterBanner
          projectName={projectName}
          sessionName={sessionName}
          draft={state.draft}
        />
      )}
      {batch && (
        <DecisionApprovalPanel
          projectName={projectName}
          sessionName={sessionName}
          batch={batch}
        />
      )}
    </>
  );
}
