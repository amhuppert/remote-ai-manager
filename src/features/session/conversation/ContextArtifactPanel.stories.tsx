import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ContextArtifactPanel from "@/features/session/conversation/ContextArtifactPanel";
import {
  contextArtifactKeys,
  type ContextArtifactTarget,
} from "@/lib/context-artifacts/query-keys";
import {
  contextArtifactsBaseUrl,
  type ContextArtifactListItem,
} from "@/lib/context-artifacts/queries";
import {
  buildArtifactDetail,
  buildArtifactListItem,
  buildMaximalEnvelope,
} from "@/components/context-artifacts/fixtures";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "command-center",
  sessionName: "csm-compaction-demo",
  conversationId: "conv-fixture-1",
};

function conversationRow(
  overrides: Partial<ContextArtifactListItem> = {},
): ContextArtifactListItem {
  return buildArtifactListItem({
    kind: "conversation_compaction",
    messageIndex: null,
    messageId: null,
    ...overrides,
  });
}

/**
 * Deterministic fixture client: list (and detail, when complete) rows are
 * seeded into the cache with an infinite staleTime so stories never touch the
 * network.
 */
function seededClient(rows: ContextArtifactListItem[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(contextArtifactKeys.list(target), rows);
  const complete = rows.find((row) => row.status === "complete");
  if (complete) {
    client.setQueryData(
      contextArtifactKeys.detail(target, complete.id),
      buildArtifactDetail({
        ...complete,
        payload: buildMaximalEnvelope(),
      }),
    );
  }
  return client;
}

/**
 * The list query always refetches on mount (its per-hook staleTime overrides
 * the seeded client's Infinity default), so the seeded cache alone is not
 * enough — answer the panel's API calls from the fixtures too.
 */
function stubFetch(rows: ContextArtifactListItem[]) {
  const listUrl = contextArtifactsBaseUrl(target);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      return Promise.resolve(
        json({ artifactId: "art-1", status: "pending" }, 202),
      );
    }
    if (method === "DELETE") return Promise.resolve(json({ deleted: true }));
    if (String(input) === listUrl) return Promise.resolve(json(rows));
    return Promise.resolve(
      json(
        buildArtifactDetail({
          ...conversationRow(),
          payload: buildMaximalEnvelope(),
        }),
      ),
    );
  };
}

function paneDecorator(
  rows: ContextArtifactListItem[],
  widthClass = "w-[420px]",
) {
  return function PaneDecorator(Story: React.ComponentType) {
    stubFetch(rows);
    return (
      <QueryClientProvider client={seededClient(rows)}>
        <div
          className={`flex h-[640px] flex-col bg-bg-base p-md ${widthClass}`}
        >
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

const meta = {
  title: "Session/ContextArtifactPanel",
  component: ContextArtifactPanel,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: { target, conversationName: "compaction-demo" },
} satisfies Meta<typeof ContextArtifactPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Complete artifact with every envelope section populated (narrow pane). */
export const Complete = {
  decorators: [paneDecorator([conversationRow()])],
} satisfies Story;

/** The same artifact at the designed width: two-column grid + sticky rail. */
export const CompleteWide = {
  decorators: [paneDecorator([conversationRow()], "w-[1240px]")],
} satisfies Story;

/** A compaction run in flight. */
export const Pending = {
  decorators: [paneDecorator([conversationRow({ status: "pending" })])],
} satisfies Story;

/** Failed run: stored error + retry. */
export const Failed = {
  decorators: [
    paneDecorator([
      conversationRow({
        status: "failed",
        error: "transcript_too_large_for_single_pass",
      }),
    ]),
  ],
} satisfies Story;

/** No artifact yet: invites the first compaction. */
export const Empty = {
  decorators: [paneDecorator([])],
} satisfies Story;

/** Stale artifact: freshness note above the envelope. */
export const Stale = {
  decorators: [
    paneDecorator([conversationRow({ stale: true, staleBehindMessages: 9 })]),
  ],
} satisfies Story;

/** Archived conversation: identity line carries the archived badge (§11.4). */
export const Archived = {
  args: { archived: true },
  decorators: [paneDecorator([conversationRow()])],
} satisfies Story;
