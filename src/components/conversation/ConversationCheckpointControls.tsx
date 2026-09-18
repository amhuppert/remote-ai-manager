"use client";

import { useCallback, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { useCompactMutation } from "@/lib/context-artifacts/mutations";
import { useContextArtifacts } from "@/lib/context-artifacts/queries";
import type { CheckpointTarget } from "@/lib/conversation-checkpoints/query-keys";
import { cn } from "@/lib/ui/cn";

import ArtifactMenuItems from "./ArtifactMenuItems";
import CheckpointMenuItems from "./CheckpointMenuItems";
import CheckpointPanel from "./CheckpointPanel";
import CheckpointStatusChip from "./CheckpointStatusChip";
import { deriveCompactionChipState } from "./compaction-chip-state";
import { useCheckpointArtifactComparison } from "./use-checkpoint-artifact-comparison";
import { useConversationCheckpoint } from "./use-conversation-checkpoint";

export interface ConversationCheckpointControlsProps {
  target: CheckpointTarget;
  sourceConversation?: import("@/lib/conversations/schemas").PublicConversationState;
  initialForkModel?: import("@/lib/agent-backends/schemas").BackendModelSelection;
  onForkCreated?(
    conversation: import("@/lib/conversations/schemas").PublicConversationState,
  ): void;
  /** Opens the existing queue-review UI for uncertain queued deliveries. */
  onReviewQueue?: () => void;
  /** Opens the host's compaction-artifact reader, when it has one. */
  onViewArtifact?: () => void;
  /** Scrolls the host transcript to a merged message index. */
  onNavigateToMessage?: (messageIndex: number) => void;
  /** External-geometry utilities only. */
  className?: string;
}

// The session host's Actions trigger, reused verbatim so the two conversation
// scopes present the same affordance.
const TRIGGER_CLASS = cn(
  "group inline-flex h-[26px] cursor-pointer items-center gap-[5px] rounded-sm border border-solid border-border-default bg-transparent px-[10px] font-mono text-[0.68rem] font-semibold tracking-[0.04em] text-text-secondary uppercase transition-all duration-150 ease-[ease]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
  "data-[state=closed]:hover:border-cyan data-[state=closed]:hover:text-text-primary",
  "data-[state=open]:border-cyan data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary",
);

/**
 * The self-contained checkpoint surface for a host that has no conversation
 * actions menu of its own (the project cockpit's pane header).
 *
 * The session host composes the same pieces into its existing menu instead;
 * both go through `useConversationCheckpoint`, so the two scopes share one
 * state owner and one set of actions rather than two implementations that
 * could disagree about what a phase means.
 */
export default function ConversationCheckpointControls({
  target,
  sourceConversation,
  initialForkModel,
  onForkCreated,
  onReviewQueue,
  onViewArtifact,
  onNavigateToMessage,
  className,
}: ConversationCheckpointControlsProps): React.JSX.Element {
  const surface = useConversationCheckpoint(target);
  const artifact = useCheckpointArtifactComparison(target);
  const [panelOpen, setPanelOpen] = useState(false);
  const [preparation, setPreparation] = useState(false);
  const openPanel = useCallback(() => {
    setPreparation(false);
    setPanelOpen(true);
  }, []);
  const prepareHandoff = useCallback(() => {
    setPreparation(true);
    setPanelOpen(true);
  }, []);

  // The rolling artifact is this menu's other action. It shares the list query
  // the comparison above already observes, so offering it here costs no extra
  // read — and a project conversation stops being the one scope from which its
  // own artifact is unreachable.
  const { data: artifacts } = useContextArtifacts(target);
  const compaction = deriveCompactionChipState(artifacts);
  const { mutate: compactMutate } = useCompactMutation(target);
  const generateArtifact = useCallback(() => {
    compactMutate({
      kind: "conversation_compaction",
      force: compaction.kind === "outdated" || undefined,
    });
  }, [compactMutate, compaction.kind]);

  return (
    <span className={cn("inline-flex items-center gap-sm", className)}>
      <CheckpointStatusChip state={surface.chip} onOpen={openPanel} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={TRIGGER_CLASS}
            title="Context checkpoint actions"
          >
            <span className="leading-none">Checkpoint</span>
            <span
              className="text-[8px] text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180 group-data-[state=open]:text-cyan"
              aria-hidden="true"
            >
              {"▼"}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" layoutClassName="w-[280px]">
          <CheckpointMenuItems
            chip={surface.chip}
            action={surface.action}
            onCompactContextNow={surface.start}
            onPrepareHandoff={prepareHandoff}
            onViewCheckpoint={openPanel}
          />
          <DropdownMenuSeparator />
          <ArtifactMenuItems
            compaction={compaction}
            onGenerateArtifact={generateArtifact}
            {...(onViewArtifact === undefined ? {} : { onViewArtifact })}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <CheckpointPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        surface={surface}
        preparation={preparation}
        onPreparationComplete={() => setPreparation(false)}
        {...(sourceConversation ? { sourceConversation } : {})}
        {...(initialForkModel ? { initialForkModel } : {})}
        {...(onForkCreated ? { onForkCreated } : {})}
        artifact={artifact}
        {...(onReviewQueue === undefined ? {} : { onReviewQueue })}
        {...(onNavigateToMessage === undefined ? {} : { onNavigateToMessage })}
      />
    </span>
  );
}
