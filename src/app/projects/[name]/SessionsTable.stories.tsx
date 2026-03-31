import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionState } from "@/types";
import SessionsTable from "./SessionsTable";

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

function makeSession(
  overrides: Partial<SessionState> &
    Pick<SessionState, "sessionName" | "branchName">,
): SessionState {
  return {
    worktreePath: `/tmp/wt/${overrides.sessionName}`,
    createdAt: dayAgo,
    lastActivityAt: hourAgo,
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    workflow: null,
    workflowHistory: [],
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

const sampleSessions: SessionState[] = [
  makeSession({
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    lastActivityAt: now,
    conversations: [],
  }),
  makeSession({
    sessionName: "add-dashboard",
    branchName: "csm/add-dashboard",
    creationMode: "focus",
    lastActivityAt: hourAgo,
  }),
  makeSession({
    sessionName: "fix-nav-bug",
    branchName: "csm/fix-nav-bug",
    targetBranch: "csm/implement-auth",
    parentSessionName: "implement-auth",
    creationMode: "optimistic",
    lastActivityAt: hourAgo,
  }),
  makeSession({
    sessionName: "refactor-api",
    branchName: "csm/refactor-api",
    finished: true,
    lastActivityAt: dayAgo,
  }),
  makeSession({
    sessionName: "child-of-dashboard",
    branchName: "csm/child-of-dashboard",
    targetBranch: "csm/add-dashboard",
    parentSessionName: "add-dashboard",
    lastActivityAt: now,
  }),
];

const meta = {
  title: "Sessions/SessionsTable",
  component: SessionsTable,
  args: {
    sessions: sampleSessions,
    projectName: "my-app",
    nameFilter: "",
    onNameFilterChange: fn(),
    onBranch: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default table with mixed main/child sessions */
export const Default = {
  args: {},
} satisfies Story;

/** All sessions targeting main */
export const AllMainTargets = {
  args: {
    sessions: sampleSessions.filter((s) => s.targetBranch === "main"),
  },
} satisfies Story;

/** Sessions with non-main targets highlighted */
export const ChildSessions = {
  args: {
    sessions: sampleSessions.filter((s) => s.targetBranch !== "main"),
  },
} satisfies Story;

/** Empty table */
export const Empty = {
  args: {
    sessions: [],
  },
} satisfies Story;

/** Without onBranch — Branch button hidden */
export const NoBranchAction = {
  args: {
    onBranch: undefined,
  },
} satisfies Story;
