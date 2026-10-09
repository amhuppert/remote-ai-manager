"use client";

import { ChevronDownIcon } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

import AgentProfileChoicePopover from "./AgentProfileChoicePopover";

export interface NewConversationProfileButtonProps {
  projectName: string;
  onCreate: (profile: AgentProfileRef) => void;
  /** Where the surface can create one: a conversation the shared conversation core runs. */
  onCreateCore?: (profile: AgentProfileRef) => void;
  pending: boolean;
  disabled?: boolean;
}

/**
 * The profile-selecting companion to a one-click "new conversation" control.
 *
 * The session sidebar, the session overview header, and the cockpit's tab strip
 * all create a conversation in a single click, and each is a hot path with a
 * hotkey; this is the panel that names a profile for the occasional
 * conversation that wants one. Everything about how the choice behaves lives in
 * `AgentProfileChoicePopover`.
 */
export default function NewConversationProfileButton({
  projectName,
  onCreate,
  onCreateCore,
  pending,
  disabled,
}: NewConversationProfileButtonProps): React.JSX.Element {
  return (
    <AgentProfileChoicePopover
      projectName={projectName}
      triggerLabel="Choose an agent profile"
      title="New conversation"
      confirmLabel="Create conversation"
      onConfirm={onCreate}
      {...(onCreateCore !== undefined
        ? {
            secondaryAction: {
              label: "Create core conversation",
              onConfirm: onCreateCore,
            },
          }
        : {})}
      disabled={disabled || pending}
      trigger={
        <IconButton
          aria-label="Choose an agent profile"
          disabled={disabled || pending}
        >
          <ChevronDownIcon size={14} />
        </IconButton>
      }
    />
  );
}
