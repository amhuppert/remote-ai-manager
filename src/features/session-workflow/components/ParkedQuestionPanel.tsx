"use client";

import AskQuestionPanel from "@/components/AskQuestionPanel";
import {
  useUserInputGate,
  type UserInputStanding,
} from "@/hooks/use-user-input-gate";

interface ParkedQuestionPanelProps {
  projectName: string;
  sessionName: string;
  standing: UserInputStanding;
}

/**
 * The answer panel for ONE lane waiting on the human.
 *
 * A component per lane rather than a list built in the container: the answer
 * mutation is bound to the conversation it answers, so a context with two
 * waiting validators needs two of them — one hook instance each, each posting
 * to its own asking conversation.
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
  return <AskQuestionPanel {...panelProps} compact />;
}
