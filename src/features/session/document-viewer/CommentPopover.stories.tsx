import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { CommentComposerCapability } from "@/components/document-viewer/annotation-contract";

import CommentPopover from "./CommentPopover";

const ANCHOR = {
  sectionId: "overview",
  headingLabel: "Overview",
  line: 5,
  charStart: 19,
  charEnd: 42,
  quote: "agent-produced markdown",
  prefix: "The viewer renders ",
  suffix: " with selection commenting.",
  docRevision: "revision-1",
};

const meta = {
  title: "Session/DocumentViewer/CommentPopover",
  component: CommentPopover,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  decorators: [
    (Story) => (
      <div className="rounded-lg bg-bg-surface p-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    anchor: ANCHOR,
    onCancel: fn(),
    onSuccess: fn(),
    onPendingChange: fn(),
  },
} satisfies Meta<typeof CommentPopover>;

export default meta;
type Story = StoryObj<typeof meta>;

const persistOnly: CommentComposerCapability = {
  kind: "persist-only",
  submit: fn().mockResolvedValue(undefined),
};

const persistOrSend: CommentComposerCapability = {
  kind: "persist-or-send",
  submit: fn().mockResolvedValue(undefined),
};

export const PersistOnly: Story = {
  args: { composer: persistOnly },
};

export const PersistOrSend: Story = {
  args: { composer: persistOrSend },
};

export const Pending: Story = {
  args: {
    composer: {
      kind: "persist-only",
      submit: () => new Promise<void>(() => {}),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox"), "Keep this draft open");
    await userEvent.click(canvas.getByRole("button", { name: "Add comment" }));
    await expect(
      canvas.getByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
  },
};

export const Rejected: Story = {
  args: {
    composer: {
      kind: "persist-only",
      submit: async () => {
        throw new Error("Revision is no longer proposed");
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole("textbox"),
      "Preserve this exact draft",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add comment" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Revision is no longer proposed",
    );
    await expect(canvas.getByRole("textbox")).toHaveValue(
      "Preserve this exact draft",
    );
  },
};
