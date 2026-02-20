import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MergeDialog from "./MergeDialog";

const meta = {
  title: "Session/MergeDialog",
  component: MergeDialog,
  args: {
    open: true,
    onClose: fn(),
    projectName: "my-app",
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    commitCount: 5,
  },
} satisfies Meta<typeof MergeDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const SingleCommit = {
  args: {
    branchName: "csm/quick-fix",
    commitCount: 1,
    sessionName: "quick-fix",
  },
} satisfies Story;

export const ManyCommits = {
  args: {
    branchName: "csm/major-refactor",
    commitCount: 23,
    sessionName: "major-refactor",
  },
} satisfies Story;

export const Closed = {
  args: { open: false },
} satisfies Story;
