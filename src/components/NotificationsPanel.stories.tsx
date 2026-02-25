import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import NotificationsPanel from "./NotificationsPanel";
import type { NotificationItem } from "./NotificationsPanel";

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

const sampleConversations: NotificationItem[] = [
  {
    type: "conversation",
    id: "conv-001",
    name: "Implement user authentication",
    status: "running",
    timestamp: minutesAgo(2),
    projectName: "my-app",
    sessionName: "implement-auth",
  },
  {
    type: "conversation",
    id: "conv-002",
    name: "Fix database connection pooling",
    status: "awaiting",
    timestamp: minutesAgo(8),
    projectName: "my-app",
    sessionName: "fix-db-pool",
  },
  {
    type: "conversation",
    id: "conv-003",
    name: null,
    status: "waiting_for_input",
    timestamp: minutesAgo(15),
    projectName: "api-server",
    sessionName: "add-rate-limiting",
  },
];

const sampleJobs: NotificationItem[] = [
  {
    type: "merge",
    id: "merge-001",
    branchName: "csm/implement-auth",
    status: "running",
    timestamp: minutesAgo(1),
    projectName: "my-app",
    sessionName: "implement-auth",
  },
  {
    type: "commit",
    id: "commit-001",
    branchName: "csm/fix-db-pool",
    status: "success",
    commitHash: "a3f7c2e",
    timestamp: minutesAgo(5),
    projectName: "my-app",
    sessionName: "fix-db-pool",
  },
  {
    type: "merge",
    id: "merge-002",
    branchName: "csm/add-rate-limiting",
    status: "conflicts",
    conflictCount: 3,
    timestamp: minutesAgo(12),
    projectName: "api-server",
    sessionName: "add-rate-limiting",
  },
  {
    type: "merge",
    id: "merge-003",
    branchName: "csm/refactor-sessions",
    status: "success",
    mergeHash: "b4e8d1f",
    timestamp: minutesAgo(30),
    projectName: "my-app",
    sessionName: "refactor-sessions",
  },
  {
    type: "commit",
    id: "commit-002",
    branchName: "csm/update-deps",
    status: "error",
    errorMessage: "Pre-commit hook failed: test suite has 2 failures",
    timestamp: minutesAgo(45),
    projectName: "my-app",
    sessionName: "update-deps",
  },
];

const meta = {
  title: "Components/NotificationsPanel",
  component: NotificationsPanel,
  args: {
    open: true,
    onClose: fn(),
    onNavigate: fn(),
    items: [],
    loading: false,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof NotificationsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mixed activity — conversations and jobs together */
export const MixedActivity = {
  args: {
    items: [...sampleConversations, ...sampleJobs],
  },
} satisfies Story;

/** Only active conversations */
export const ConversationsOnly = {
  args: {
    items: sampleConversations,
  },
} satisfies Story;

/** Only job notifications */
export const JobsOnly = {
  args: {
    items: sampleJobs,
  },
} satisfies Story;

/** Empty state — no activity */
export const Empty = {
  args: {
    items: [],
  },
} satisfies Story;

/** Loading state */
export const Loading = {
  args: {
    items: [],
    loading: true,
  },
} satisfies Story;

/** Single merge conflict notification */
export const SingleMergeConflict = {
  args: {
    items: [
      {
        type: "merge",
        id: "merge-solo",
        branchName: "csm/implement-auth",
        status: "conflicts",
        conflictCount: 1,
        timestamp: minutesAgo(3),
        projectName: "my-app",
        sessionName: "implement-auth",
      } satisfies NotificationItem,
    ],
  },
} satisfies Story;

/** Panel closed */
export const Closed = {
  args: {
    open: false,
    items: [...sampleConversations, ...sampleJobs],
  },
} satisfies Story;
