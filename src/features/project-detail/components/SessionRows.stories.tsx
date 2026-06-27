import type { ComponentType, JSX } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionListItem } from "@/lib/sessions/schemas";
import SessionRows from "./SessionRows";

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

function makeSession(
  overrides: Partial<SessionListItem> &
    Pick<SessionListItem, "sessionName" | "branchName">,
): SessionListItem {
  return {
    worktreePath: `/tmp/wt/${overrides.sessionName}`,
    createdAt: dayAgo,
    lastActivityAt: hourAgo,
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    derivedStatus: "idle",
    promptCount: 0,
    derivedLastActivityAt: hourAgo,
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...overrides,
  };
}

const sampleSessions: SessionListItem[] = [
  makeSession({
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    lastActivityAt: now,
  }),
  makeSession({
    sessionName: "add-dashboard",
    branchName: "csm/add-dashboard",
    creationMode: "normal",
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
  title: "Sessions/SessionRows",
  component: SessionRows,
  args: {
    sessions: sampleSessions,
    projectName: "my-app",
    sort: { id: "lastActivityAt", desc: true },
    onSortChange: fn(),
    selection: new Set<string>(),
    onToggleSelect: fn(),
    onToggleAll: fn(),
    onBranch: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionRows>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default rows with mixed main/child sessions */
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

/**
 * An archived row above a normal row. Archived rows are dimmed, but the dim must
 * not wrap the open kebab popup: open the archived row's menu and it must be fully
 * opaque and paint above the next row's controls (e.g. its TDD toggle).
 */
export const Archived = {
  args: {
    sessions: [
      makeSession({
        sessionName: "archived-experiment",
        branchName: "csm/archived-experiment",
        archived: true,
        lastActivityAt: now,
      }),
      makeSession({
        sessionName: "active-below",
        branchName: "csm/active-below",
        lastActivityAt: hourAgo,
      }),
    ],
  },
} satisfies Story;

/** Empty rows */
export const Empty = {
  args: {
    sessions: [],
  },
} satisfies Story;

/** Without onBranch — Branch kebab option still renders, just no-ops */
export const NoBranchAction = {
  args: {
    onBranch: undefined,
  },
} satisfies Story;

/**
 * Mobile viewport (≤768px). Rows collapse to a two-line card layout: status rail
 * + mode dot + name on top, branch chip + relative time below, kebab on the right.
 * Checkbox, target, prompts, status pill text, and TDD toggle move out of the row
 * (selection/sort behavior hidden — actions live in the kebab).
 */
export const Mobile = {
  args: {},
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
  decorators: [
    (Story: ComponentType): JSX.Element => (
      <div style={{ width: 375 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Story;
