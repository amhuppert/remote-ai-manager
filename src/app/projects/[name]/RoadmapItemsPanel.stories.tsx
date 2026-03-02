import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoadmapItem } from "@/types";
import RoadmapItemsPanel from "./RoadmapItemsPanel";

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();

const sampleItems: RoadmapItem[] = [
  {
    id: "1",
    title: "Fix authentication timeout on long-running sessions",
    description:
      "Sessions expire after 30 minutes of inactivity even when Claude is still processing.",
    type: "bug",
    status: "incomplete",
    archived: false,
    createdAt: lastWeek,
    updatedAt: lastWeek,
  },
  {
    id: "2",
    title: "Add dark mode toggle to settings",
    description: null,
    type: "feature",
    status: "done",
    archived: false,
    createdAt: lastWeek,
    updatedAt: yesterday,
  },
  {
    id: "3",
    title: "Consider WebSocket migration for real-time updates",
    description:
      "SSE works but WebSockets could enable bidirectional communication for interactive debugging.",
    type: "idea",
    status: "incomplete",
    archived: false,
    createdAt: yesterday,
    updatedAt: yesterday,
  },
  {
    id: "4",
    title: "User settings page with configurable defaults",
    description: null,
    type: "feature",
    status: "incomplete",
    archived: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "5",
    title: "Fix memory leak in diff viewer on large changesets",
    description:
      "The virtualized list doesn't properly clean up DOM nodes when switching between sessions rapidly.",
    type: "bug",
    status: "done",
    archived: false,
    createdAt: lastWeek,
    updatedAt: now,
  },
  {
    id: "6",
    title: "Add voice command shortcuts",
    description: null,
    type: "idea",
    status: "incomplete",
    archived: true,
    createdAt: lastWeek,
    updatedAt: yesterday,
  },
  {
    id: "7",
    title: "Implement session templates for common workflows",
    description: null,
    type: "feature",
    status: "incomplete",
    archived: true,
    createdAt: lastWeek,
    updatedAt: lastWeek,
  },
];

/** Mock fetch for stories — intercepts roadmap-items API calls */
function mockFetch(items: RoadmapItem[]) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/roadmap-items")) {
      if (init?.method === "POST") {
        return Response.json(
          { item: { ...items[0], id: "new", title: "New item" } },
          { status: 201 },
        );
      }
      if (init?.method === "PATCH" || init?.method === "DELETE") {
        return Response.json({ ok: true });
      }
      return Response.json({ items });
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
  items,
  children,
}: {
  items: RoadmapItem[];
  children: React.ReactNode;
}) {
  const cleanup = mockFetch(items);
  // Cleanup on unmount — best-effort for stories
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  return (
    <QueryClientProvider client={createQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const meta = {
  title: "Projects/RoadmapItemsPanel",
  component: RoadmapItemsPanel,
  args: {
    projectName: "test-project",
  },
  decorators: [
    (Story) => (
      <WithMockData items={sampleItems}>
        <div style={{ maxWidth: 800, padding: 24 }}>
          <Story />
        </div>
      </WithMockData>
    ),
  ],
} satisfies Meta<typeof RoadmapItemsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Empty = {
  decorators: [
    (Story) => (
      <WithMockData items={[]}>
        <div style={{ maxWidth: 800, padding: 24 }}>
          <Story />
        </div>
      </WithMockData>
    ),
  ],
} satisfies Story;

export const AllDone = {
  decorators: [
    (Story) => (
      <WithMockData
        items={sampleItems
          .filter((i) => !i.archived)
          .map((i) => ({ ...i, status: "done" as const }))}
      >
        <div style={{ maxWidth: 800, padding: 24 }}>
          <Story />
        </div>
      </WithMockData>
    ),
  ],
} satisfies Story;

export const BugsOnly = {
  decorators: [
    (Story) => (
      <WithMockData items={sampleItems.filter((i) => i.type === "bug")}>
        <div style={{ maxWidth: 800, padding: 24 }}>
          <Story />
        </div>
      </WithMockData>
    ),
  ],
} satisfies Story;
