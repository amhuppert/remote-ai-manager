import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import SmartMergeDialog from "./SmartMergeDialog";

const meta = {
  title: "Session/SmartMergeDialog",
  component: SmartMergeDialog,
  args: {
    open: true,
    onClose: fn(),
    projectName: "my-app",
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    commitCount: 5,
    hasUncommittedChanges: false,
  },
} satisfies Meta<typeof SmartMergeDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default state — configure merge message and auto-resolve toggle */
export const Default = {
  args: {},
} satisfies Story;

/** With uncommitted changes warning */
export const WithUncommitted = {
  args: {
    hasUncommittedChanges: true,
  },
} satisfies Story;

/** Single commit to merge */
export const SingleCommit = {
  args: {
    branchName: "csm/quick-fix",
    commitCount: 1,
    sessionName: "quick-fix",
  },
} satisfies Story;

/** After submitting — job started confirmation */
export const Submitted = {
  args: {
    initialSubmitted: true,
  },
} satisfies Story;

/** Submitted with auto-resolve disabled — shows manual review messaging */
export const SubmittedManualReview = {
  args: {
    initialSubmitted: true,
    initialAutoResolve: false,
  },
} satisfies Story;

/** Dialog closed */
export const Closed = {
  args: { open: false },
} satisfies Story;
