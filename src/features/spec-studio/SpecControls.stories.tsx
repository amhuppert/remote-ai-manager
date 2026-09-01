import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";

import { PolicyDialog } from "./SpecControls";

const meta = {
  title: "Specs/Studio/GatePolicy",
  component: PolicyDialog,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: {
    currentPolicy: { preset: "contract-bearing" },
    pending: false,
    error: null,
    onChangePolicy: fn(),
  },
} satisfies Meta<typeof PolicyDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContractBearing: Story = {};

export const ExploratoryConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /Exploratory/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Review policy change" }),
    );
  },
};

export const DraftImpact: Story = {
  args: {
    openDraft: {
      revisionId: "revision-8",
      revisionNumber: 8,
      pinnedStage: "design",
      governanceConsultedGates: ["design"],
    },
  },
};
