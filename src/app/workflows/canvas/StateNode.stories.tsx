import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import StateNode from "./StateNode";

const meta = {
  title: "Workflows/Canvas/StateNode",
  component: StateNode,
  args: {
    id: "demoState",
    label: "demoState",
    x: 40,
    y: 40,
    onClick: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: 320,
          height: 160,
          background: "var(--bg-base)",
          borderRadius: 8,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StateNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Atomic = {
  args: { kind: "atomic" },
} satisfies Story;

export const Initial = {
  args: { kind: "atomic", status: "initial", label: "idle" },
} satisfies Story;

export const Success = {
  args: { kind: "final", status: "success", label: "completed" },
} satisfies Story;

export const Failure = {
  args: { kind: "final", status: "failure", label: "failed" },
} satisfies Story;

export const Warning = {
  args: { kind: "atomic", status: "warning", label: "fixingValidation" },
} satisfies Story;

export const Transient = {
  args: { kind: "transient", label: "finalizingTurn" },
} satisfies Story;

export const WithInvokes = {
  args: {
    kind: "atomic",
    label: "executing",
    invokes: ["executePrompt"],
    height: 84,
  },
} satisfies Story;

export const Selected = {
  args: { kind: "atomic", status: "initial", selected: true },
} satisfies Story;
