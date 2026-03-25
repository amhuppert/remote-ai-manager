import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import BranchSelector from "./BranchSelector";

const sampleSessions = [
  { sessionName: "implement-auth", branchName: "csm/implement-auth" },
  { sessionName: "add-dashboard", branchName: "csm/add-dashboard" },
  { sessionName: "fix-nav-bug", branchName: "csm/fix-nav-bug" },
];

const meta = {
  title: "Components/BranchSelector",
  component: BranchSelector,
  args: {
    sessions: sampleSessions,
    selectedParent: null,
    onSelect: fn(),
    disabled: false,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 440, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BranchSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default state — main selected, sessions available */
export const Default = {
  args: {},
} satisfies Story;

/** Parent session selected */
export const ParentSelected = {
  args: {
    selectedParent: "implement-auth",
  },
} satisfies Story;

/** No sessions available — only main option */
export const NoSessions = {
  args: {
    sessions: [],
  },
} satisfies Story;

/** Many sessions — scrollable list */
export const ManySessions = {
  args: {
    sessions: [
      ...sampleSessions,
      { sessionName: "refactor-api", branchName: "csm/refactor-api" },
      { sessionName: "update-deps", branchName: "csm/update-deps" },
      { sessionName: "add-tests", branchName: "csm/add-tests" },
      {
        sessionName: "long-branch-name-feature",
        branchName: "csm/very-long-feature-branch-name-that-might-overflow",
      },
    ],
  },
} satisfies Story;

/** Disabled state */
export const Disabled = {
  args: {
    selectedParent: "implement-auth",
    disabled: true,
  },
} satisfies Story;
