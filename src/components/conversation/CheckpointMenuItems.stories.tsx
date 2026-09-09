import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import CheckpointMenuItems from "@/components/conversation/CheckpointMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

const meta = {
  title: "Components/CheckpointMenuItems",
  component: CheckpointMenuItems,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: {
    chip: { kind: "ready" },
    onCompactContextNow: fn(),
    onViewCheckpoint: fn(),
  },
  decorators: [
    (Story) => (
      <div className="bg-bg-base p-lg">
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-sm border border-solid border-border-default px-md py-xs font-mono text-[0.7rem] text-text-secondary"
            >
              Actions
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" layoutClassName="w-[280px]">
            <Story />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ),
  ],
} satisfies Meta<typeof CheckpointMenuItems>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Eligible: the action is executable. */
export const Available = {
  args: { action: { kind: "available" } },
} satisfies Story;

/** Temporarily ineligible: disabled, with the specific reason readable. */
export const TurnActive = {
  args: {
    chip: { kind: "none" },
    action: {
      kind: "disabled",
      code: "turn_active",
      reason: "A turn is running. The checkpoint can start once it settles.",
    },
  },
} satisfies Story;

/** Owned by a workflow: no executable action is offered at all. */
export const ConversationOwned = {
  args: {
    chip: { kind: "none" },
    action: {
      kind: "unsupported",
      code: "conversation_owned",
      reason:
        "A workflow or collaboration owns this conversation's turns, so a checkpoint would retire context it is still using.",
    },
  },
} satisfies Story;

/** A backend with no checkpoint capability — the artifact action still works. */
export const BackendUnsupported = {
  args: {
    chip: { kind: "none" },
    action: {
      kind: "unsupported",
      code: "backend_unsupported",
      reason:
        "This conversation's agent backend declares no checkpoint capability. Generate a compaction artifact instead.",
    },
  },
} satisfies Story;

/** An operation already holds the conversation's checkpoint slot. */
export const AlreadyRunning = {
  args: {
    chip: { kind: "building" },
    action: {
      kind: "in_progress",
      code: "checkpoint_pending",
      reason: "A checkpoint is already running for this conversation.",
      operationId: "op-4",
      phase: "building",
    },
  },
} satisfies Story;

/** Unresolved outcome: recovery is explicit, never continued in place. */
export const RecoveryRequired = {
  args: {
    chip: { kind: "needs_reconciliation", lastStablePhase: "delivering" },
    action: {
      kind: "recovery",
      code: "recovery_required",
      reason:
        "An earlier checkpoint's outcome is unresolved. Supersede it explicitly with a recovery checkpoint — it is never continued in place.",
      operationId: "op-5",
    },
  },
} satisfies Story;
