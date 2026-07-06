import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageActions from "./MessageActions";
import {
  contextArtifactKeys,
  type ContextArtifactTarget,
} from "@/lib/context-artifacts/query-keys";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  buildArtifactDetail,
  buildArtifactListItem,
} from "./context-artifacts/fixtures";

const meta = {
  title: "Components/MessageActions",
  component: MessageActions,
  args: {
    messageIndex: 2,
    content: [
      {
        type: "text",
        text: "Can you refactor the authentication module to use JWT tokens instead of session cookies? Make sure to update the middleware as well.",
      },
    ],
    onFork: fn(),
  },
  decorators: [
    (Story) => (
      <div
        className="message user"
        style={{
          position: "relative",
          padding: "0",
          maxWidth: "600px",
        }}
      >
        <div className="message-role">You</div>
        <div className="message-content">
          <p>
            Can you refactor the authentication module to use JWT tokens instead
            of session cookies? Make sure to update the middleware as well.
          </p>
        </div>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const MobileWidth = {
  args: {},
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;

const compactionTarget: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

/** Passes the compaction gate: an assistant message with a tool_use block. */
const compactableContent: MessageContentBlock[] = [
  { type: "text", text: "Ran the failing suite and isolated the flake." },
  { type: "tool_use", name: "Bash" },
];

/**
 * Deterministic fixture client: the artifact list (and the detail row for the
 * Complete story's viewer) is seeded into the cache, so no network is hit.
 */
function seededDecorator(rows: ContextArtifactListItem[]) {
  return function SeededQueryClient(Story: React.ComponentType) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(contextArtifactKeys.list(compactionTarget), rows);
    const detail = buildArtifactDetail();
    client.setQueryData(
      contextArtifactKeys.detail(compactionTarget, detail.id),
      detail,
    );
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}

const compactionArgs = {
  messageIndex: 3,
  role: "assistant",
  content: compactableContent,
  compactionTarget,
  messageRef: {
    conversationName: "Refactor parser",
    timestamp: "2026-07-06T12:00:00Z",
    model: "opus",
  },
} satisfies Partial<React.ComponentProps<typeof MessageActions>>;

/** No artifact yet → "Compact message". */
export const CompactAvailable = {
  args: compactionArgs,
  decorators: [seededDecorator([])],
} satisfies Story;

/** Artifact pending → disabled action with a spinner. */
export const CompactPending = {
  args: compactionArgs,
  decorators: [seededDecorator([buildArtifactListItem({ status: "pending" })])],
} satisfies Story;

/** Complete artifact → "View compacted message" toggles the inline viewer. */
export const CompactComplete = {
  args: compactionArgs,
  decorators: [seededDecorator([buildArtifactListItem()])],
} satisfies Story;

/** Failed artifact → "Compaction failed — retry". */
export const CompactFailed = {
  args: compactionArgs,
  decorators: [
    seededDecorator([
      buildArtifactListItem({
        status: "failed",
        error: "transcript_too_large_for_single_pass",
      }),
    ]),
  ],
} satisfies Story;
