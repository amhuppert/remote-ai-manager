"use client";

import AskQuestionPanel from "@/components/AskQuestionPanel";
import {
  useUserInputGate,
  type UserInputStanding,
} from "@/hooks/use-user-input-gate";
import { parseLaneStateKey } from "@/lib/workflow-graph/lane-identity";

interface ParkedQuestionPanelProps {
  projectName: string;
  sessionName: string;
  standing: UserInputStanding;
}

/**
 * Which lane is waiting, in the operator's words. A cohort parks per seat, so a
 * validator's row has to name the seat rather than the lane kind — two
 * "Context Validator" cards would be indistinguishable.
 */
function laneLabel(laneKey: string): string {
  const identity = parseLaneStateKey(laneKey);
  if (identity === null) return laneKey;
  if (identity.assignmentId !== null) return identity.assignmentId;
  return identity.lane === "implementer" ? "Implementer" : identity.lane;
}

/**
 * The answer panel for ONE lane waiting on the human.
 *
 * A component per lane rather than a list built in the container: the answer
 * mutation is bound to the conversation it answers, so a context with two
 * waiting validators needs two of them — one hook instance each, each posting
 * to its own asking conversation.
 *
 * The card is the answering end of the gates list (E2 · README §10): a gate row
 * reads *parked question · "…"* and lands here, so the surface it lands on
 * repeats that framing — blue for a question the run asked, naming the lane and
 * the size of the batch — with the existing answering flow inside it.
 */
export default function ParkedQuestionPanel({
  projectName,
  sessionName,
  standing,
}: ParkedQuestionPanelProps) {
  const panelProps = useUserInputGate({
    projectName,
    sessionName,
    standing,
  });
  const questionCount = standing.questions.length;
  return (
    <section
      aria-label={`Parked question — ${laneLabel(standing.laneKey)}`}
      data-testid="parked-question-panel"
      data-lane-key={standing.laneKey}
      className="flex flex-col overflow-hidden rounded-md border border-solid border-blue-dim bg-bg-base"
    >
      <header className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-blue-glow px-3 py-[9px]">
        <span className="font-mono text-[0.74rem] font-semibold text-blue">
          Parked question — {laneLabel(standing.laneKey)}
        </span>
        <span className="ml-auto font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {questionCount === 1
            ? "1 question awaiting you"
            : `${questionCount} questions awaiting you`}
        </span>
      </header>
      <div className="px-3 py-[11px]">
        <AskQuestionPanel {...panelProps} compact />
      </div>
    </section>
  );
}
