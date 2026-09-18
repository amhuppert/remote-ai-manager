import {
  capturedHandoff,
  pendingHandoff,
} from "@/lib/conversation-checkpoints/handoff-fixture";
import { checkpointHandoffReceipt } from "@/lib/conversation-checkpoints/receipt";
import { checkpointHandoffEligibilityFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";

import CheckpointPanel from "@/components/conversation/CheckpointPanel";
import CheckpointStatusChip from "@/components/conversation/CheckpointStatusChip";
import { QueueDeliveryReview } from "@/components/session/prompt/QueueDeliveryReview";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";

import {
  CheckpointStoryProvider,
  checkpointSurfaceFixture,
  STORY_BOUNDARY_SEQ,
  STORY_PROJECT_TARGET,
  STORY_SESSION_TARGET,
} from "./checkpoint-story-fixtures";

const meta = {
  title: "Components/CheckpointPanel",
  component: CheckpointPanel,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    // `onReviewQueue` is deliberately NOT supplied: the panel's own default
    // (close, then focus the composer's queue review) is the production path,
    // and a story that stubbed it would hide a host that wired nothing.
    onNavigateToMessage: fn(),
    surface: checkpointSurfaceFixture(),
  },
  decorators: [
    (Story, context) => {
      const surface = context.args.surface;
      return (
        <CheckpointStoryProvider
          target={surface.target}
          receipts={surface.recent}
        >
          <div className="min-h-[600px] bg-bg-base p-lg">
            <Story />
          </div>
        </CheckpointStoryProvider>
      );
    },
  ],
} satisfies Meta<typeof CheckpointPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

/** No checkpoint has ever been taken for this conversation. */
export const Empty = {
  args: { surface: checkpointSurfaceFixture({ receipts: [] }) },
} satisfies Story;

export const Building = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-4",
          phase: "building",
          frozen: false,
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
      ],
      action: {
        kind: "in_progress",
        code: "checkpoint_pending",
        reason: "A checkpoint is already running for this conversation.",
        operationId: "op-4",
        phase: "building",
      },
    }),
  },
} satisfies Story;

export const Retiring = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-4",
          phase: "retiring",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
      ],
    }),
  },
} satisfies Story;

/** Ready: the seed is frozen and the NEXT ordinary message will carry it. */
export const Ready = {
  args: { surface: checkpointSurfaceFixture() },
} satisfies Story;

/** Applied: an input receipt confirmed the seed reached a turn. */
export const Applied = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          phase: "applied",
          hasAcceptedContinuation: true,
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
          delivery: {
            attemptId: "attempt-9",
            inputFingerprint: "fp-in",
            submittedInputFingerprint: "fp-sub",
            queuedAttemptId: null,
            queuedMessageId: null,
          },
          acceptance: {
            attemptId: "attempt-9",
            seedHash: "seed-hash",
            acceptedAt: "2026-09-01T00:05:00.000Z",
          },
        }),
      ],
    }),
  },
} satisfies Story;

export const AppliedWhileRunning = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "66df53e1-1f90-47f5-8b90-b2794bb59f9c",
          phase: "applied",
          hasAcceptedContinuation: true,
          capturedThroughSeq: 755,
          omissions: [
            {
              category: "recent_dialogue_units_omitted",
              detail:
                "4 older exchanges outside the recent-dialogue budget; read the archive by seq range",
            },
          ],
        }),
      ],
      action: {
        kind: "disabled",
        code: "turn_active",
        reason: "A turn is running. The checkpoint can start once it settles.",
      },
    }),
  },
} satisfies Story;

export const SavedHandoffOpened = {
  play: async ({ userEvent }) => {
    const modal = within(document.body);
    await userEvent.click(
      await modal.findByRole("button", { name: "Saved handoff" }),
    );
    await modal.findByText(/Objective: land the checkpoint UI/);
  },
} satisfies Story;

export const DetailsOpened = {
  args: AppliedWhileRunning.args,
  play: async ({ userEvent }) => {
    const modal = within(document.body);
    await userEvent.click(
      await modal.findByRole("button", { name: "Checkpoint details" }),
    );
    await modal.findByText("Seed sha256");
  },
} satisfies Story;

export const Cancelled = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-2",
          phase: "cancelled",
          frozen: false,
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
      ],
    }),
  },
} satisfies Story;

/** A failed build names its stage and never retired the runtime. */
export const Failed = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-3",
          phase: "failed",
          frozen: false,
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
          failure: {
            code: "working_state_invalid",
            message:
              "the repaired working state still cited a source outside the captured boundary",
          },
        }),
      ],
    }),
  },
} satisfies Story;

/** Reconciliation: a deterministic repair is offered, and it sends nothing. */
export const NeedsReconciliation = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-5",
          phase: "needs_reconciliation",
          lastStablePhase: "retiring",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
      ],
      action: {
        kind: "recovery",
        code: "recovery_required",
        reason:
          "An earlier checkpoint's outcome is unresolved. Supersede it explicitly with a recovery checkpoint — it is never continued in place.",
        operationId: "op-5",
      },
    }),
  },
} satisfies Story;

/** Unknown delivery: the queue is reviewed first; nothing is replayed here. */
export const UnresolvedQueuedDelivery = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-6",
          phase: "needs_reconciliation",
          lastStablePhase: "delivering",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
          delivery: {
            attemptId: "attempt-11",
            inputFingerprint: "fp-in",
            submittedInputFingerprint: "fp-sub",
            queuedAttemptId: "queued-3",
            queuedMessageId: "msg-7",
          },
        }),
      ],
      action: {
        kind: "queue_review",
        code: "queue_review_required",
        reason:
          "A queued delivery may or may not have reached the provider. Review the uncertain queued messages first — CC never replays uncertain input automatically.",
        operationId: "op-6",
      },
    }),
  },
} satisfies Story;

/** The rolling reading artifact has moved past the saved checkpoint. */
export const NewerRollingArtifact = {
  args: {
    surface: checkpointSurfaceFixture(),
    artifact: {
      coveredEndSeq: STORY_BOUNDARY_SEQ + 200,
      updatedAt: "2026-09-02T09:30:00.000Z",
    },
  },
} satisfies Story;

/** The same panel on a PROJECT conversation — no session path anywhere. */
export const ProjectScope = {
  args: {
    surface: checkpointSurfaceFixture({
      target: STORY_PROJECT_TARGET,
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          scope: "project",
          conversationId: STORY_PROJECT_TARGET.conversationId,
          phase: "ready",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
      ],
    }),
  },
} satisfies Story;

/** Several checkpoints on one conversation, newest first. */
export const RepeatedCheckpoints = {
  args: {
    surface: checkpointSurfaceFixture({
      target: STORY_SESSION_TARGET,
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-3",
          ordinal: 3,
          phase: "ready",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "applied",
          capturedThroughSeq: 96,
          hasAcceptedContinuation: true,
        }),
        checkpointReceiptFixture({
          operationId: "op-1",
          ordinal: 1,
          phase: "applied",
          capturedThroughSeq: 48,
          hasAcceptedContinuation: true,
        }),
      ],
    }),
  },
} satisfies Story;

/**
 * The panel as a user reaches it: opened from the status chip, so keyboard
 * activation and focus RETURN to the chip on close are both exercisable.
 */
function ChipAndPanel({
  surface,
}: {
  surface: ReturnType<typeof checkpointSurfaceFixture>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-md">
      <CheckpointStatusChip state={surface.chip} onOpen={() => setOpen(true)} />
      <CheckpointPanel
        open={open}
        onOpenChange={setOpen}
        surface={surface}
        onNavigateToMessage={fn()}
      />
    </div>
  );
}

export const OpenedFromChip = {
  args: { open: false, surface: checkpointSurfaceFixture() },
  render: (args) => <ChipAndPanel surface={args.surface} />,
} satisfies Story;

/**
 * The evidence destinations, not just the links: the complete entry is opened
 * in place and both image handles have recovered their bytes, so a browser
 * pass can confirm the archive is actually reachable from a saved checkpoint.
 */
export const EvidenceOpened = {
  args: { surface: checkpointSurfaceFixture() },
  // Queried against the document, not the story canvas: the panel is a Radix
  // dialog and portals its content to <body>.
  play: async ({ userEvent }) => {
    const modal = within(document.body);
    await userEvent.click(
      await modal.findByRole("button", { name: /Original archive/ }),
    );
    await userEvent.click(
      await modal.findByRole("button", { name: /open complete entry/i }),
    );
    await modal.findByText(/complete recorded tool result/i);
  },
} satisfies Story;

/**
 * A conversation compacted several times, with the SECOND checkpoint selected:
 * its own boundary, its own entry export, its own images. This is the route to
 * evidence that is not the newest.
 */
export const EarlierCheckpointSelected = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-3",
          ordinal: 3,
          phase: "ready",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
        }),
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "applied",
          capturedThroughSeq: 96,
          hasAcceptedContinuation: true,
        }),
      ],
    }),
  },
  play: async ({ userEvent }) => {
    const modal = within(document.body);
    await userEvent.click(
      await modal.findByRole("button", { name: /Checkpoint history/ }),
    );
    await userEvent.click(await modal.findByRole("button", { name: /#2/ }));
    await userEvent.click(
      await modal.findByRole("button", { name: /Original archive/ }),
    );
    await modal.findByText(/captured through raw seq 96/);
  },
} satisfies Story;

/** More operations exist than the panel loaded; paging reads further back. */
export const OlderCheckpointsAvailable = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-9", ordinal: 9 }),
        checkpointReceiptFixture({
          operationId: "op-8",
          ordinal: 8,
          phase: "applied",
          capturedThroughSeq: 96,
        }),
      ],
      hasOlder: true,
      onLoadOlder: fn(),
    }),
  },
} satisfies Story;

/**
 * The uncertain-delivery destination, wired the way a host wires it.
 *
 * The panel supplies no `onReviewQueue` — the production default is to close
 * the modal and focus the composer, where the retained messages already are.
 * This story therefore renders a real composer beside it: the review is the
 * actual `QueueDeliveryReview`, and the prompt carries the `data-cc-prompt-id`
 * that focus restoration looks for. Activating the control by KEYBOARD has to
 * close the dialog, put focus on the prompt, and leave Retry and Discard
 * reachable — none of which a stubbed callback could show.
 */
const RETAINED_QUEUE: PendingQueuedMessage[] = [
  {
    id: "msg-7",
    content: [
      { type: "text", text: "rerun the probe against the fresh runtime" },
    ],
    status: "uncertain",
    enqueuedAt: "2026-09-01T00:04:00.000Z",
    updatedAt: "2026-09-01T00:04:30.000Z",
    deliveryStartedAt: "2026-09-01T00:04:10.000Z",
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: "attempt-11",
    attemptCount: 1,
    error: "the connection dropped after the input was sent",
    metadata: null,
  },
];

function QueueReviewHost({
  surface,
}: {
  surface: ReturnType<typeof checkpointSurfaceFixture>;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-md">
      <CheckpointPanel open={open} onOpenChange={setOpen} surface={surface} />
      {/* The composer the panel sends the reader back to. */}
      <div className="flex flex-col gap-sm rounded-md border border-solid border-border-default p-sm">
        <QueueDeliveryReview entries={RETAINED_QUEUE} onResolve={fn()} />
        <div
          contentEditable
          suppressContentEditableWarning
          data-cc-prompt-id="story-prompt"
          role="textbox"
          aria-label="Message"
          tabIndex={0}
          className="min-h-[48px] rounded-sm border border-solid border-border-default px-sm py-xs font-mono text-[0.8rem] text-text-primary"
        />
      </div>
    </div>
  );
}

export const QueueReviewDestination = {
  args: {
    open: true,
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-6",
          phase: "needs_reconciliation",
          lastStablePhase: "delivering",
          capturedThroughSeq: STORY_BOUNDARY_SEQ,
          delivery: {
            attemptId: "attempt-11",
            inputFingerprint: "fp-in",
            submittedInputFingerprint: "fp-sub",
            queuedAttemptId: "queued-3",
            queuedMessageId: "msg-7",
          },
        }),
      ],
      action: {
        kind: "queue_review",
        code: "queue_review_required",
        reason:
          "A queued delivery may or may not have reached the provider. Review the uncertain queued messages first — CC never replays uncertain input automatically.",
        operationId: "op-6",
      },
    }),
  },
  render: (args) => <QueueReviewHost surface={args.surface} />,
  play: async ({ userEvent }) => {
    const screen = within(document.body);
    const review = await screen.findByRole("button", {
      name: /review queued messages/i,
    });
    review.focus();
    await userEvent.keyboard("{Enter}");

    // The modal is gone and the retained message is in front of the reader.
    await expect(screen.queryByRole("dialog")).toBeNull();
    await expect(
      screen.getByRole("group", { name: /queued deliveries needing review/i }),
    ).toBeVisible();
    // Focus lands on the composer prompt rather than <body>, so the keyboard
    // user arrives where the retained messages are. This is scheduled after
    // Radix's own close-time focus restoration, so it has to be awaited.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: /message/i }),
      ),
    );
    await expect(
      screen.getByRole("button", { name: /retry delivery/i }),
    ).toBeEnabled();
    await expect(
      screen.getByRole("button", { name: /discard queued message/i }),
    ).toBeEnabled();
  },
} satisfies Story;

export const PrepareToolDisabled = {
  args: {
    preparation: true,
    surface: {
      ...checkpointSurfaceFixture({ receipts: [] }),
      handoff: checkpointHandoffEligibilityFixture(),
    },
  },
} satisfies Story;

export const PrepareInstructionOnly = {
  args: {
    preparation: true,
    surface: {
      ...checkpointSurfaceFixture({ receipts: [] }),
      handoff: checkpointHandoffEligibilityFixture({
        mode: "instruction-only",
      }),
    },
  },
} satisfies Story;

export const CaptureUnavailable = {
  args: {
    preparation: true,
    surface: {
      ...checkpointSurfaceFixture({ receipts: [] }),
      handoff: checkpointHandoffEligibilityFixture({
        available: false,
        mode: null,
        reason: "Current agent continuity is unavailable.",
      }),
    },
  },
} satisfies Story;

export const CapturingHandoff = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          phase: "building",
          frozen: false,
          handoff: checkpointHandoffReceipt(pendingHandoff()),
        }),
      ],
    }),
  },
} satisfies Story;

export const StoppingHandoff = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({
          phase: "building",
          frozen: false,
          handoff: checkpointHandoffReceipt(
            pendingHandoff({
              stage: "settling",
              stopIntent: "skip",
              startedAt: "2026-09-07T12:04:01.000Z",
            }),
          ),
        }),
      ],
    }),
  },
} satisfies Story;

export const HandoffIncluded = {
  args: {
    surface: checkpointSurfaceFixture({
      action: {
        kind: "in_progress",
        code: "checkpoint_pending",
        reason: "A checkpoint is already running for this conversation.",
        operationId: "op-1",
        phase: "ready",
      },
      receipts: [
        checkpointReceiptFixture({
          handoff: checkpointHandoffReceipt(
            capturedHandoff({
              stage: "included",
              finalizedAt: "2026-09-07T12:05:00.000Z",
            }),
          ),
        }),
      ],
    }),
  },
} satisfies Story;
export const HandoffSeedBudgetOmission = {
  args: {
    surface: checkpointSurfaceFixture({
      action: {
        kind: "in_progress",
        code: "checkpoint_pending",
        reason: "A checkpoint is already running for this conversation.",
        operationId: "op-1",
        phase: "ready",
      },
      receipts: [
        checkpointReceiptFixture({
          handoff: checkpointHandoffReceipt(
            capturedHandoff({
              stage: "omitted",
              omissionReason: "seed_budget",
              finalizedAt: "2026-09-07T12:05:00.000Z",
            }),
          ),
        }),
      ],
    }),
  },
} satisfies Story;
export const CaptureCleanupHold = {
  args: {
    surface: checkpointSurfaceFixture({
      action: {
        kind: "recovery",
        code: "recovery_required",
        reason:
          "An earlier checkpoint's outcome is unresolved. Supersede it explicitly with a recovery checkpoint — it is never continued in place.",
        operationId: "op-1",
      },
      receipts: [
        checkpointReceiptFixture({
          phase: "needs_reconciliation",
          lastStablePhase: "building",
          frozen: false,
          handoff: checkpointHandoffReceipt(
            pendingHandoff({
              stage: "omitted",
              omissionReason: "interrupted",
              finalizedAt: "2026-09-07T12:05:00.000Z",
              continuationDisposition: "clear",
            }),
          ),
        }),
      ],
    }),
  },
} satisfies Story;
