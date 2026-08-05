"use client";

import { WithTooltip } from "@/components/ui/WithTooltip";
import { Spinner } from "@/components/ui/Spinner";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { useGenerateConversationNameMutation } from "@/lib/conversations/mutations";
import { msgActionBtnClass } from "./CopyMessageButton";

interface GenerateNameFromMessageButtonProps {
  target: ContextArtifactTarget;
  messageIndex: number;
}

export default function GenerateNameFromMessageButton({
  target,
  messageIndex,
}: GenerateNameFromMessageButtonProps) {
  const generateName = useGenerateConversationNameMutation();
  const label = generateName.isPending
    ? "Generating name…"
    : "Name conversation from this message";

  const handleClick = () => {
    if (target.scope === "project") {
      generateName.mutate({
        scope: "project",
        projectName: target.projectName,
        conversationId: target.conversationId,
        messageIndex,
      });
      return;
    }

    generateName.mutate({
      projectName: target.projectName,
      sessionName: target.sessionName,
      conversationId: target.conversationId,
      messageIndex,
    });
  };

  return (
    <WithTooltip label={label}>
      <button
        type="button"
        className={msgActionBtnClass}
        onClick={handleClick}
        disabled={generateName.isPending}
        aria-busy={generateName.isPending || undefined}
        aria-label={label}
        title={label}
      >
        {generateName.isPending ? (
          <Spinner size="sm" tone="inherit" />
        ) : (
          <GenerateNameIcon />
        )}
      </button>
    </WithTooltip>
  );
}

function GenerateNameIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 3H7.5M2 6H6M2 9H5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9 5.5L9.4 6.6L10.5 7L9.4 7.4L9 8.5L8.6 7.4L7.5 7L8.6 6.6L9 5.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
