import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn } from "storybook/test";
import CreateSessionModal from "./CreateSessionModal";
import { _useSessionsStore } from "@/stores/sessions.store";

const sampleSessions = [
  {
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    targetBranch: "main",
    parentSessionName: null,
    finished: false,
    archived: false,
    creationMode: "normal" as const,
    conversations: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    tddEnabled: false,
  },
  {
    sessionName: "add-dashboard",
    branchName: "csm/add-dashboard",
    targetBranch: "main",
    parentSessionName: null,
    finished: false,
    archived: false,
    creationMode: "normal" as const,
    conversations: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    tddEnabled: false,
  },
  {
    sessionName: "fix-nav-bug",
    branchName: "csm/fix-nav-bug",
    targetBranch: "csm/implement-auth",
    parentSessionName: "implement-auth",
    finished: false,
    archived: false,
    creationMode: "optimistic" as const,
    conversations: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    tddEnabled: true,
  },
];

function mockFetch(sessions: typeof sampleSessions) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/sessions") && (!init?.method || init.method === "GET")) {
      return Response.json({ sessions });
    }
    if (url.includes("/sessions") && init?.method === "POST") {
      return Response.json(
        { ...sessions[0], sessionName: "new-session" },
        { status: 201 },
      );
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function WithMockData({
  sessions,
  branchFromParent,
  children,
}: {
  sessions: typeof sampleSessions;
  branchFromParent?: string;
  children: React.ReactNode;
}) {
  const qc = createQueryClient();

  useEffect(() => {
    const cleanup = mockFetch(sessions);
    return cleanup;
  }, [sessions]);

  useEffect(() => {
    if (branchFromParent) {
      _useSessionsStore.getState().openCreateModal(branchFromParent);
    }
  }, [branchFromParent]);

  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Sessions/CreateSessionModal",
  component: CreateSessionModal,
  args: {
    projectName: "my-app",
    open: true,
    onClose: fn(),
  },
} satisfies Meta<typeof CreateSessionModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Closed = {
  args: { open: false },
} satisfies Story;

/** With active sessions showing BranchSelector */
export const WithSessions = {
  decorators: [
    (Story) => (
      <WithMockData sessions={sampleSessions}>
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;

/** With a parent session pre-selected via store */
export const ParentSelected = {
  decorators: [
    (Story) => (
      <WithMockData sessions={sampleSessions} branchFromParent="implement-auth">
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;

/** No active sessions — BranchSelector hidden */
export const NoSessions = {
  decorators: [
    (Story) => (
      <WithMockData sessions={[]}>
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;
