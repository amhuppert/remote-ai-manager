import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GenericToastSource } from "@/components/ToastHost";
import type {
  TicketAttachment,
  TicketDetail,
  TicketLinkSummary,
  TicketSessionLink,
} from "@/lib/tickets/schemas";
import type { TicketSpecReadThrough } from "@/lib/specs/queries";
import TicketDetailView from "@/features/tickets/components/TicketDetailView";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
  cursor: { modelId: "composer-2.5", effort: "high" },
};

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

function makeAttachment(
  overrides: Partial<TicketAttachment> & Pick<TicketAttachment, "id">,
): TicketAttachment {
  return {
    ticketId: "t-cc-12",
    description:
      "Profiling notes from the spike: where index render cost goes as attachment counts grow.",
    payload: { kind: "note", markdown: "## Baseline\n- initial render: 412ms" },
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

const ACTIVE_SESSION: TicketSessionLink = {
  id: "link-1",
  ticketId: "t-cc-12",
  projectPath: "/home/alex/github/command-center",
  sessionName: "csm/ticket-attachments",
  sessionCreatedAt: daysAgo(2),
  startMode: "agent",
  linkedAt: daysAgo(2),
  endedAt: null,
  endReason: null,
};

const ENDED_SESSIONS: TicketSessionLink[] = [
  {
    id: "link-2",
    ticketId: "t-cc-12",
    projectPath: "/home/alex/github/command-center",
    sessionName: "csm/spike-virtualize",
    sessionCreatedAt: null,
    startMode: "prepared",
    linkedAt: daysAgo(6),
    endedAt: daysAgo(4),
    endReason: "finished",
  },
  {
    id: "link-3",
    ticketId: "t-cc-12",
    projectPath: "/home/alex/github/command-center",
    sessionName: "csm/spike-window-index",
    sessionCreatedAt: null,
    startMode: "agent",
    linkedAt: daysAgo(9),
    endedAt: daysAgo(8),
    endReason: "deleted",
  },
];

function makeDetail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: "t-cc-12",
    projectPath: "/home/alex/github/command-center",
    projectName: "command-center",
    number: 12,
    title: "Ticket attachment index: virtualize long lists",
    description:
      "The attachment index on ticket detail re-renders every entry on any SSE delta. With agent-authored tickets regularly reaching 40–60 attachments, interaction latency on the dossier view exceeds the responsiveness contract.\n\nVirtualize the index list (windowed rendering), keeping keyboard navigation, expand-in-place previews, and description edit affordances intact.",
    workType: "feature",
    status: "in_progress",
    createdAt: daysAgo(3),
    updatedAt: minutesAgo(6),
    attachments: [
      makeAttachment({ id: "att-1" }),
      makeAttachment({
        id: "att-2",
        description:
          "Constraints agreed with maintainers: what must not regress.",
      }),
    ],
    sessions: [ACTIVE_SESSION, ...ENDED_SESSIONS],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness — the view renders from the query cache over a mocked fetch, so
// optimistic edits, rollbacks, and retries behave exactly like the app.
// ---------------------------------------------------------------------------

interface MockDetailOptions {
  failPatches?: number;
  /** `hang` keeps the provisioning request pending forever. */
  start?: "success" | "hang";
  /**
   * Liveness-aware session-link map override. By default the map mirrors the
   * served link rows (`active` = un-ended); pass a contradicting map to model
   * a stale row whose session already finished or was deleted (demotion is
   * reconciliation-driven, so the row can lag the truth). A function receives
   * the 0-based fetch index, so a story can serve a map that changes between
   * fetches — a session ending while the view holds a cached map.
   */
  sessionLinks?:
    | Record<string, TicketLinkSummary>
    | ((fetchIndex: number) => Record<string, TicketLinkSummary>);
  linkedSpecs?: TicketSpecReadThrough["specs"];
}

function linkSummariesFromDetail(
  detail: TicketDetail,
): Record<string, TicketLinkSummary> {
  return Object.fromEntries(
    detail.sessions.map((link) => [
      link.sessionName,
      {
        ticketId: link.ticketId,
        projectName: detail.projectName,
        number: detail.number,
        title: detail.title,
        active: link.endedAt === null,
        linkedAt: link.linkedAt,
        endedAt: link.endedAt,
      },
    ]),
  );
}

function mockDetailFetch(
  detail: TicketDetail,
  {
    failPatches = 0,
    start = "success",
    sessionLinks,
    linkedSpecs = [],
  }: MockDetailOptions,
) {
  let served = detail;
  let patchFailuresLeft = failPatches;
  let sessionLinkFetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";
    const parsed = new URL(url, window.location.origin);
    const detailMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
    );
    const startMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)\/start$/,
    );

    if (
      method === "GET" &&
      parsed.pathname ===
        `/api/specs/${encodeURIComponent(detail.projectName)}/ticket-read-through/${detail.number}`
    ) {
      return Response.json({ specs: linkedSpecs });
    }

    if (
      method === "GET" &&
      /^\/api\/projects\/([^/]+)\/tickets\/session-links$/.test(parsed.pathname)
    ) {
      const links =
        typeof sessionLinks === "function"
          ? sessionLinks(sessionLinkFetches)
          : sessionLinks;
      sessionLinkFetches += 1;
      return Response.json(links ?? linkSummariesFromDetail(served));
    }

    if (startMatch && method === "POST") {
      if (start === "hang") return new Promise(() => {});
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const activeLink: TicketSessionLink = {
        id: "link-new",
        ticketId: served.id,
        projectPath: served.projectPath,
        sessionName: "csm/ticket-12-work",
        sessionCreatedAt: new Date().toISOString(),
        startMode: body.mode === "prepared" ? "prepared" : "agent",
        linkedAt: new Date().toISOString(),
        endedAt: null,
        endReason: null,
      };
      served = {
        ...served,
        status: "in_progress",
        sessions: [activeLink, ...served.sessions],
        updatedAt: new Date().toISOString(),
      };
      return Response.json({
        ticket: served,
        sessionName: activeLink.sessionName,
        conversationId: "conv-new",
        initialPromptQueued: activeLink.startMode === "agent",
      });
    }

    if (detailMatch) {
      if (method === "GET") return Response.json(served);
      if (method === "PATCH") {
        if (patchFailuresLeft > 0) {
          patchFailuresLeft -= 1;
          return Response.json({ error: "update_failed" }, { status: 500 });
        }
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : {};
        served = { ...served, ...body, updatedAt: new Date().toISOString() };
        return Response.json(served);
      }
      if (method === "DELETE") {
        return Response.json({
          id: served.id,
          projectPath: served.projectPath,
          projectName: served.projectName,
          number: served.number,
        });
      }
    }
    if (method === "GET" && parsed.pathname === "/api/tickets") {
      return Response.json([]);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function DetailHarness({
  detail,
  failPatches = 0,
  start = "success",
  sessionLinks,
  linkedSpecs,
}: {
  detail: TicketDetail;
} & MockDetailOptions): React.JSX.Element {
  const cleanup = mockDetailFetch(detail, {
    failPatches,
    start,
    sessionLinks,
    linkedSpecs,
  });
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TicketDetailView
        projectName={detail.projectName}
        number={detail.number}
        defaultAgentBackend="claude"
        backendDefaults={BACKEND_DEFAULTS}
      />
      <GenericToastSource />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/TicketDetailPage",
  component: TicketDetailView,
  // Stories render through DetailHarness (query-cache-backed, like the app);
  // meta-level args only satisfy the component's required-prop contract.
  args: {
    projectName: "command-center",
    number: 12,
    defaultAgentBackend: "claude",
    backendDefaults: BACKEND_DEFAULTS,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets/command-center/12" },
    },
  },
} satisfies Meta<typeof TicketDetailView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * The full dossier: identity header with status pill, type badge and actions,
 * markdown description, and the rail carrying Fields (free status/type
 * transitions) and Session history with an active link.
 */
export const FullDossier: Story = {
  render: () => <DetailHarness detail={makeDetail()} />,
};

/**
 * Linked spec state is read through live: composite phase, criterion proof
 * progress, workflow status, and an amendment-changed source task share one
 * card without changing the ticket's own In Progress lifecycle.
 */
export const LinkedSpecReadThrough: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail()}
      linkedSpecs={[
        {
          specId: "spec-native-sdd",
          slug: "native-sdd",
          name: "Native spec-driven development",
          revision: 5,
          phase: { primary: "executing", authoringFacet: "draft" },
          criteriaProgress: { proven: 7, total: 12 },
          linkedTasks: [
            {
              taskElementId: "task-ticket-read-through",
              taskHandle: "T7",
              sourceTaskState: "changed",
              workStatus: "running",
            },
          ],
        },
      ]}
    />
  ),
};

/**
 * Only historical rows remain. Existing finished sessions stay navigable;
 * deleted sessions keep their end reason without linking to a missing target.
 */
export const HistoricalSessions: Story = {
  render: () => {
    const finished = ENDED_SESSIONS[0]!;
    return (
      <DetailHarness
        detail={makeDetail({ status: "done", sessions: ENDED_SESSIONS })}
        sessionLinks={{
          [finished.sessionName]: {
            ticketId: finished.ticketId,
            projectName: "command-center",
            number: 12,
            title: "Ticket attachment index: virtualize long lists",
            active: false,
            linkedAt: finished.linkedAt,
            endedAt: finished.endedAt,
          },
        }}
      />
    );
  },
};

/**
 * A deleted session name has since been reused by another ticket. The old
 * history row must not navigate to that unrelated replacement instance.
 */
export const ReplacedSessionHistory: Story = {
  render: () => {
    const replaced = ENDED_SESSIONS[1]!;
    return (
      <DetailHarness
        detail={makeDetail({ status: "done", sessions: [replaced] })}
        sessionLinks={{
          [replaced.sessionName]: {
            ticketId: "different-ticket",
            projectName: "command-center",
            number: 99,
            title: "Unrelated replacement session",
            active: true,
            linkedAt: minutesAgo(1),
            endedAt: null,
          },
        }}
      />
    );
  },
};

/**
 * Deletion is guarded by an AlertDialog naming the ticket and its attachment
 * count; confirming removes the ticket and leaves the view.
 */
export const DeleteConfirmation: Story = {
  render: () => <DetailHarness detail={makeDetail()} />,
  play: async ({ canvas }) => {
    const trigger = await canvas.findByRole("button", {
      name: "Delete ticket",
    });
    await userEvent.click(trigger);
  },
};

/**
 * The first title save is rejected: the previous value is restored and an
 * inline Retry re-issues the edit (the second attempt succeeds).
 */
export const TitleEditFailure: Story = {
  render: () => <DetailHarness detail={makeDetail()} failPatches={1} />,
};

/**
 * No active session: the header's Start action opens StartTicketDialog with
 * the agent/prepared mode choice (agent pre-selected); confirming provisions
 * the session, closes the dialog, and the dossier shows In Progress with the
 * new session card active.
 */
export const StartWorkDialog: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail({ status: "not_started", sessions: ENDED_SESSIONS })}
    />
  ),
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: /start work/i }),
    );
  },
};

/**
 * The provisioning pending state: the confirm shows "Provisioning…" with a
 * spinner and the mode choice locks, but Cancel stays enabled until the link
 * transaction commits.
 */
export const StartWorkProvisioning: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail({ status: "not_started", sessions: ENDED_SESSIONS })}
      start="hang"
    />
  ),
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: /start work/i }),
    );
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Start work" }),
    );
  },
};

/**
 * A ticket with an active session: the conflict surfaces before the dialog as
 * an AlertDialog naming the session — not a disabled button — so the reason
 * is discoverable.
 */
export const StartConflict: Story = {
  render: () => <DetailHarness detail={makeDetail()} />,
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: /start work/i }),
    );
  },
};

/**
 * A stale link row: the persisted link still has `endedAt: null` (demotion is
 * reconciliation-driven), but the liveness-aware session-link map knows the
 * session already ended. Start must NOT be blocked by the conflict alert —
 * it opens the start dialog so reconciliation can run server-side.
 */
export const StartAfterSessionEnded: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail()}
      sessionLinks={{
        [ACTIVE_SESSION.sessionName]: {
          ticketId: ACTIVE_SESSION.ticketId,
          projectName: "command-center",
          number: 12,
          title: "Ticket attachment index: virtualize long lists",
          active: false,
          linkedAt: ACTIVE_SESSION.linkedAt,
          endedAt: null,
        },
      }}
    />
  ),
};

/**
 * The session ends AFTER the map was cached as active: nothing invalidates
 * the session-link query on session lifecycle changes, so the mounted view's
 * cache still says `active: true`. The Start decision must re-check liveness
 * at click time instead of trusting the cached map — the click opens the
 * start dialog, not the conflict alert.
 */
export const StartAfterCachedActiveSessionEnds: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail()}
      sessionLinks={(fetchIndex) => ({
        [ACTIVE_SESSION.sessionName]: {
          ticketId: ACTIVE_SESSION.ticketId,
          projectName: "command-center",
          number: 12,
          title: "Ticket attachment index: virtualize long lists",
          active: fetchIndex === 0,
          linkedAt: ACTIVE_SESSION.linkedAt,
          endedAt: fetchIndex === 0 ? null : minutesAgo(1),
        },
      })}
    />
  ),
};

/** No description, no attachments, no sessions — the un-enriched dossier. */
export const EmptyDossier: Story = {
  render: () => (
    <DetailHarness
      detail={makeDetail({
        status: "not_started",
        description: "",
        attachments: [],
        sessions: [],
      })}
    />
  ),
};

/** Stacked dossier header, main content, attachment index, and metadata rail. */
export const MobileDossier: Story = {
  render: () => <DetailHarness detail={makeDetail()} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
