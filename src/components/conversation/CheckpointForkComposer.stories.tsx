import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import UnifiedComposer from "@/features/project-detail/composer/UnifiedComposer";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import CheckpointForkProvenance from "./CheckpointForkProvenance";
import {
  CheckpointStoryProvider,
  STORY_PROJECT_TARGET,
} from "./checkpoint-story-fixtures";
import { checkpointForkStoryFetch } from "./checkpoint-fork-story-fixtures";

function ForkComposer({
  phase = "ready",
  initialBackend = "claude",
}: {
  phase?: "ready" | "delivering" | "applied" | "needs_reconciliation";
  initialBackend?: AgentBackendId;
}) {
  const [backend, setBackend] = useState(initialBackend);
  const target = { ...STORY_PROJECT_TARGET, conversationId: "fork" };
  const initialSelection = {
    backend: "claude" as const,
    modelSelection: { modelId: "opus", parameters: { effort: "high" } },
  };
  const origin = checkpointForkOriginFixture({
    source: STORY_PROJECT_TARGET,
    evidenceSource: STORY_PROJECT_TARGET,
    initialSelection,
    ...(phase === "ready"
      ? {}
      : { submission: { backend, at: "2026-09-12T12:00:00.000Z" } }),
  });
  const conversation = makeConversationState({
    id: target.conversationId,
    scope: "project",
    name: "Implement the next phase",
    agentBackend: backend,
    promptCount: phase === "applied" ? 1 : 0,
    checkpointFork: origin,
    pendingPromptText:
      "Implement the next phase using the saved checkpoint. Verify the focused task before continuing.",
  });
  const receipt = {
    ...checkpointReceiptFixture({
      conversationId: target.conversationId,
      operationId: origin.operationId,
      scope: "project",
      phase,
      hasAcceptedContinuation: phase === "applied",
    }),
    forkOrigin: origin,
  };
  const transport = checkpointForkStoryFetch(target);
  return (
    <CheckpointStoryProvider
      target={target}
      receipts={[receipt]}
      additionalFetch={async (input, init) => {
        if (String(input).endsWith("/checkpoints/fork"))
          return new Response(JSON.stringify({ receipt }), {
            headers: { "Content-Type": "application/json" },
          });
        if (String(input).includes("/pending-prompt"))
          return new Response(JSON.stringify({ ok: true }));
        return transport(input, init);
      }}
    >
      <div className="mx-auto flex max-w-[900px] flex-col gap-lg bg-bg-base p-lg">
        <CheckpointForkProvenance origin={origin} />
        <UnifiedComposer
          projectName={target.projectName}
          activeConversationId={conversation.id}
          activeConversation={conversation}
          agentBackend={backend}
          backendDefaults={{
            claude: initialSelection.modelSelection,
            codex: {
              modelId: "gpt-6-astra",
              parameters: { reasoning: "high", fast: "false" },
            },
            cursor: { modelId: "composer-2.5", parameters: {} },
          }}
          onAgentChange={setBackend}
          tokens={[]}
          onTokensChange={() => {}}
          sessions={[]}
          archivedCount={0}
          onSendPrompt={async () => "rejected"}
          onRunCommand={() => {}}
          busy={phase === "delivering"}
        />
      </div>
    </CheckpointStoryProvider>
  );
}

const meta = {
  title: "Components/CheckpointForkComposer",
  component: ForkComposer,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ForkComposer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready = {} satisfies Story;
export const CrossBackendDraft = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: /^Codex$/ }));
    await expect(page.getByRole("button", { name: /^Codex$/ })).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByRole("button", { name: /^Cursor/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
} satisfies Story;
export const FirstSubmissionPending = {
  args: { phase: "delivering", initialBackend: "codex" },
} satisfies Story;
export const Accepted = {
  args: { phase: "applied", initialBackend: "codex" },
} satisfies Story;
export const UnresolvedDelivery = {
  args: { phase: "needs_reconciliation", initialBackend: "claude" },
} satisfies Story;
