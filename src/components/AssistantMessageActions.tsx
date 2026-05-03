"use client";

import type { MessageContentBlock } from "@/types";
import CopyMessageButton from "./CopyMessageButton";

interface AssistantMessageActionsProps {
  content: MessageContentBlock[];
}

export default function AssistantMessageActions({
  content,
}: AssistantMessageActionsProps) {
  return (
    <div className="msg-actions">
      <CopyMessageButton content={content} />
    </div>
  );
}
