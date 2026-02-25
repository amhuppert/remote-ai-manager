import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MergeToast from "./MergeToast";

const meta = {
  title: "Components/MergeToast",
  component: MergeToast,
  args: {
    branchName: "csm/implement-auth",
    onAction: fn(),
    onDismiss: fn(),
    visible: true,
  },
} satisfies Meta<typeof MergeToast>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Merge completed successfully */
export const Success = {
  args: {
    variant: "success",
    mergeHash: "a3f7c2e",
  },
} satisfies Story;

/** Conflicts detected — user needs to review */
export const Conflicts = {
  args: {
    variant: "conflicts",
    conflictCount: 3,
  },
} satisfies Story;

/** Single conflict */
export const SingleConflict = {
  args: {
    variant: "conflicts",
    conflictCount: 1,
  },
} satisfies Story;

/** Merge failed with error */
export const Error = {
  args: {
    variant: "error",
    errorMessage: "Main branch has uncommitted changes",
  },
} satisfies Story;

/** Long branch name */
export const LongBranchName = {
  args: {
    variant: "success",
    branchName: "csm/very-long-feature-branch-name-that-might-overflow",
    mergeHash: "b4e8d1f",
  },
} satisfies Story;
