import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MergeDialog from "@/features/session/dialogs/MergeDialog";

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

export const ErrorSimple = {
  args: {
    defaultError: "Uncommitted changes must be committed before merging",
  },
} satisfies Story;

export const ErrorWithTerminalOutput = {
  args: {
    defaultError: "Commit failed",
    defaultOutput: `✔ Preparing lint-staged...
✗ Running tasks for staged files...
  ❯ eslint --fix --max-warnings=0:
    ✖ Failed
  ↖ Reverting to original state because of errors...
  ✔ Cleaning up temporary files...

src/app/projects/[name]/[session]/MergeDialog.tsx
  18:3  error  'foo' is defined but never used  no-unused-vars
  42:1  error  Missing semicolon                semi

✖ 2 problems (2 errors, 0 warnings)

husky - pre-commit hook exited with code 1 (error)`,
  },
} satisfies Story;

export const ErrorMergeConflict = {
  args: {
    defaultError:
      "Merge conflicts detected between this session and main. Resolve the conflicts in the worktree and try again.",
  },
} satisfies Story;
