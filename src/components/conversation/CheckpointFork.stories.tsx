import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import CheckpointPanel from "./CheckpointPanel";
import {
  checkpointSurfaceFixture,
  CheckpointStoryProvider,
  STORY_SESSION_TARGET,
  STORY_PROJECT_TARGET,
} from "./checkpoint-story-fixtures";
import {
  checkpointForkStoryFetch,
  type ForkStoryState,
} from "./checkpoint-fork-story-fixtures";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

const meta = {
  title: "Components/CheckpointFork",
  component: CheckpointPanel,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  args: {
    open: true,
    onOpenChange: fn(),
    onForkCreated: fn(),
    initialForkTicket: 131,
    sourceConversation: toPublicConversationState(
      makeConversationState({ name: "Checkpoint planning" }),
    ),
    surface: checkpointSurfaceFixture({
      target: STORY_SESSION_TARGET,
      receipts: [checkpointReceiptFixture({ ordinal: 3, phase: "applied" })],
    }),
  },
  decorators: [
    (Story, context) => (
      <CheckpointStoryProvider
        target={context.args.surface.target}
        receipts={context.args.surface.recent}
        additionalFetch={checkpointForkStoryFetch(
          context.args.surface.target,
          context.parameters.forkState as ForkStoryState | undefined,
        )}
      >
        <div className="min-h-screen bg-bg-base">
          <Story />
        </div>
      </CheckpointStoryProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Fork from this checkpoint" }),
    );
    await expect(page.getByLabelText("Next task")).toBeVisible();
  },
} satisfies Meta<typeof CheckpointPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;
export const NameRequired = {
  args: { initialForkTicket: undefined },
  play: async (context) => {
    await meta.play(context);
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.clear(page.getByLabelText("Conversation name"));
    await userEvent.click(page.getByRole("button", { name: "Create fork" }));
    await expect(page.getByText("Enter a conversation name.")).toBeVisible();
  },
} satisfies Story;
export const ProjectConversation = {
  args: { surface: checkpointSurfaceFixture({ target: STORY_PROJECT_TARGET }) },
} satisfies Story;
export const HistoricalCheckpoint = {
  args: {
    initialOperationId: "historical",
    surface: checkpointSurfaceFixture({
      receipts: [
        checkpointReceiptFixture({ operationId: "latest", ordinal: 4 }),
        checkpointReceiptFixture({
          operationId: "historical",
          ordinal: 2,
          phase: "applied",
        }),
      ],
    }),
  },
} satisfies Story;
export const InvalidModel = {
  args: {
    initialForkModel: {
      modelId: "unavailable-model",
      parameters: { effort: "high" },
    },
  },
} satisfies Story;
export const LoadingReferences = {
  args: { initialForkTicket: undefined },
  parameters: { forkState: "references_loading" },
} satisfies Story;
export const NoEligibleReferences = {
  args: { initialForkTicket: undefined },
  parameters: { forkState: "no_references" },
} satisfies Story;
export const CrossBackend = {
  play: async (context) => {
    await meta.play(context);
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Codex" }));
    await expect(page.getByRole("button", { name: "Codex" })).toHaveAttribute(
      "data-active",
      "true",
    );
  },
} satisfies Story;
export const SpecTask = {
  play: async (context) => {
    await meta.play(context);
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("combobox", { name: "Related work" }));
    await userEvent.click(page.getByRole("option", { name: "Spec task" }));
    await userEvent.click(await page.findByRole("combobox", { name: "Spec" }));
    await userEvent.click(
      await page.findByRole("option", { name: /native-sdd/ }),
    );
    await userEvent.click(
      await page.findByRole("combobox", { name: "Spec task" }),
    );
    await userEvent.click(await page.findByRole("option", { name: /T1/ }));
  },
} satisfies Story;
export const WorkflowAssignment = {
  play: async (context) => {
    await meta.play(context);
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("combobox", { name: "Related work" }));
    await userEvent.click(
      page.getByRole("option", { name: "Workflow assignment" }),
    );
    await userEvent.click(
      await page.findByRole("combobox", { name: "Workflow execution" }),
    );
    await userEvent.click(
      await page.findByRole("option", { name: /Checkpoint delivery/ }),
    );
    await userEvent.click(
      await page.findByRole("combobox", { name: "Assignment" }),
    );
    await userEvent.click((await page.findAllByRole("option"))[0]!);
  },
} satisfies Story;
async function fillAndCreateFork(context: Parameters<typeof meta.play>[0]) {
  const page = within(context.canvasElement.ownerDocument.body);
  await userEvent.click(
    await page.findByRole("button", { name: "Fork from this checkpoint" }),
  );
  await userEvent.type(
    page.getByLabelText("Next task"),
    "Implement the next phase. Preserve Q-137 and the agreed constraints.",
  );
  await userEvent.click(page.getByRole("button", { name: "Create fork" }));
}
export const CreationPending = {
  parameters: { forkState: "pending" },
  play: async (context) => {
    await fillAndCreateFork(context);
  },
} satisfies Story;
export const CreationFailure = {
  parameters: { forkState: "failed" },
  play: async (context) => {
    await fillAndCreateFork(context);
  },
} satisfies Story;

export const LongHistoryLastCheckpoint = {
  args: {
    surface: checkpointSurfaceFixture({
      receipts: Array.from({ length: 30 }, (_, index) =>
        checkpointReceiptFixture({
          operationId: `history-${30 - index}`,
          ordinal: 30 - index,
          phase: "applied",
          capturedThroughSeq: (30 - index) * 10,
        }),
      ),
    }),
  },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(
      await page.findByRole("button", { name: /Checkpoint history/ }),
    );
    const oldest = await page.findByRole("button", {
      name: "#1 Checkpoint applied seq 10",
    });
    oldest.scrollIntoView();
    oldest.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(
      await page.findByRole("button", { name: "Fork from this checkpoint" }),
    );
    await expect(
      await page.findByText("Checkpoint planning · Checkpoint #1"),
    ).toBeVisible();
    await expect(page.getByLabelText("Next task")).toBeVisible();
  },
} satisfies Story;
