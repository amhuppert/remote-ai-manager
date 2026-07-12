import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ToastContainer from "@/components/ToastContainer";
import { ticketFollowCommand } from "@/lib/tickets/attachment-commands";
import { useTicketDetailQuery } from "@/lib/tickets/queries";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  TicketAttachment,
  TicketAttachmentPayload,
  TicketDetail,
} from "@/lib/tickets/schemas";
import AttachmentIndex from "@/features/tickets/components/AttachmentIndex";

// ---------------------------------------------------------------------------
// Sample data — one attachment per kind, on a CLOSED ticket so every
// interaction story doubles as proof that attachment CRUD ignores status.
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

function makeAttachment(
  id: string,
  description: string,
  payload: TicketAttachmentPayload,
): TicketAttachment {
  return {
    id,
    ticketId: "t-cc-12",
    description,
    payload,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
  };
}

const ALL_KINDS: TicketAttachment[] = [
  makeAttachment(
    "att-file",
    "The agreed v2 API contract — endpoints, payload shapes, and error codes.",
    {
      kind: "file",
      fileName: "api-contract.md",
      snapshotKey: "ticket-content/t-cc-12/att-file/api-contract.md",
      mediaType: "text/markdown",
      sizeBytes: 2048,
      sha256: "abc123",
    },
  ),
  makeAttachment(
    "att-conv",
    "Design collaboration where the virtualization approach was chosen.",
    {
      kind: "conversation",
      projectPath: "/home/alex/github/command-center",
      sessionName: "csm/design-collab",
      conversationId: "conv-42",
      snapshotKey: "ticket-content/t-cc-12/att-conv/compaction.md",
      snapshotCapturedAt: daysAgo(2),
    },
  ),
  makeAttachment(
    "att-sess",
    "The spike session that produced the windowing prototype.",
    {
      kind: "session",
      projectPath: "/home/alex/github/command-center",
      sessionName: "csm/spike-virtualize",
    },
  ),
  makeAttachment(
    "att-rel",
    "Parent epic tracking the dossier performance work.",
    {
      kind: "related_ticket",
      ticketId: "t-cc-7",
      identifierSnapshot: "command-center#7",
    },
  ),
  makeAttachment(
    "att-note",
    "Constraints agreed with maintainers before starting.",
    {
      kind: "note",
      markdown: "## Constraints\n- keep keyboard nav\n- no new dependencies",
    },
  ),
];

function makeDetail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: "t-cc-12",
    projectPath: "/home/alex/github/command-center",
    projectName: "command-center",
    number: 12,
    title: "Ticket attachment index: virtualize long lists",
    description: "Windowed rendering for the dossier attachment index.",
    workType: "feature",
    status: "closed",
    createdAt: daysAgo(3),
    updatedAt: minutesAgo(6),
    attachments: ALL_KINDS,
    sessions: [],
    ...overrides,
  };
}

const RELATED_DETAIL: TicketDetail = {
  id: "t-cc-7",
  projectPath: "/home/alex/github/command-center",
  projectName: "command-center",
  number: 7,
  title: "Dossier performance epic",
  description: "",
  workType: "performance",
  status: "in_progress",
  createdAt: daysAgo(20),
  updatedAt: daysAgo(4),
  attachments: [],
  sessions: [],
};

// ---------------------------------------------------------------------------
// Fetch harness — the index renders from the query cache over a mocked fetch,
// so optimistic edits, removals, reconciles, and failed uploads behave exactly
// like the app.
// ---------------------------------------------------------------------------

function resolveBody(attachment: TicketAttachment): unknown {
  const payload = attachment.payload;
  switch (payload.kind) {
    case "file":
      return {
        kind: "file",
        attachment,
        fileName: payload.fileName,
        mediaType: payload.mediaType,
        sizeBytes: payload.sizeBytes,
        sha256: payload.sha256,
        encoding: "utf8",
        content: "# API contract\n\nGET /api/tickets returns the lean list.",
      };
    case "conversation":
      return {
        kind: "conversation",
        attachment,
        conversationId: payload.conversationId,
        sessionName: payload.sessionName,
        source: "live_compaction",
        sourceAvailable: true,
        markdown: "## Compaction\nThe windowing approach won on simplicity.",
        capturedAt: payload.snapshotCapturedAt,
        readCommands: [`cctl conversation get ${payload.conversationId}`],
      };
    case "session":
      return {
        kind: "session",
        attachment,
        projectName: "command-center",
        sessionName: payload.sessionName,
        finished: true,
        conversationIds: ["conv-40", "conv-41"],
        readCommands: [`cctl session get ${payload.sessionName}`],
      };
    case "related_ticket":
      return {
        kind: "related_ticket",
        attachment,
        available: true,
        ticket: RELATED_DETAIL,
        followCommand: ticketFollowCommand(payload.identifierSnapshot),
      };
    case "note":
      return { kind: "note", attachment, markdown: payload.markdown };
  }
}

interface HarnessOptions {
  /** Fail this many attachment POSTs (500) before succeeding. */
  failPosts?: number;
}

function mockAttachmentFetch(detail: TicketDetail, options: HarnessOptions) {
  let served = detail;
  let postFailuresLeft = options.failPosts ?? 0;
  let idCounter = 0;
  const original = globalThis.fetch;

  const appendAttachment = (
    description: string,
    payload: TicketAttachmentPayload,
  ): TicketAttachment => {
    const created: TicketAttachment = {
      id: `att-new-${++idCounter}`,
      ticketId: served.id,
      description,
      payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    served = { ...served, attachments: [...served.attachments, created] };
    return created;
  };

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";
    const parsed = new URL(url, window.location.origin);

    const detailMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
    );
    if (detailMatch && method === "GET") return Response.json(served);

    const collectionMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)\/attachments$/,
    );
    if (collectionMatch && method === "POST") {
      if (postFailuresLeft > 0) {
        postFailuresLeft -= 1;
        return Response.json({ error: "attach_failed" }, { status: 500 });
      }
      if (init?.body instanceof FormData) {
        const metadata = JSON.parse(String(init.body.get("metadata"))) as {
          description: string;
          fileName?: string;
          mediaType?: string;
        };
        const file = init.body.get("file") as File;
        const created = appendAttachment(metadata.description, {
          kind: "file",
          fileName: metadata.fileName ?? file.name,
          snapshotKey: `ticket-content/${served.id}/uploaded/${file.name}`,
          mediaType: metadata.mediaType ?? (file.type || null),
          sizeBytes: file.size,
          sha256: "uploaded",
        });
        return Response.json(created, { status: 201 });
      }
      const body = JSON.parse(String(init?.body)) as {
        description: string;
        payload: Record<string, unknown> & { kind: string };
      };
      const created = appendAttachment(
        body.description,
        jsonPayloadFromInput(body.payload),
      );
      return Response.json(created, { status: 201 });
    }

    const itemMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)\/attachments\/([^/]+)$/,
    );
    if (itemMatch) {
      const attachmentId = decodeURIComponent(itemMatch[3] ?? "");
      const attachment = served.attachments.find((a) => a.id === attachmentId);
      if (!attachment) {
        return Response.json({ error: "unknown_attachment" }, { status: 404 });
      }
      if (method === "GET") return Response.json(resolveBody(attachment));
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          description?: string;
          markdown?: string;
        };
        const updated: TicketAttachment = {
          ...attachment,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          payload:
            body.markdown !== undefined && attachment.payload.kind === "note"
              ? { ...attachment.payload, markdown: body.markdown }
              : attachment.payload,
          updatedAt: new Date().toISOString(),
        };
        served = {
          ...served,
          attachments: served.attachments.map((a) =>
            a.id === attachmentId ? updated : a,
          ),
        };
        return Response.json(updated);
      }
      if (method === "DELETE") {
        const ticketUpdatedAt = new Date().toISOString();
        served = {
          ...served,
          attachments: served.attachments.filter((a) => a.id !== attachmentId),
          updatedAt: ticketUpdatedAt,
        };
        return Response.json({
          attachmentId,
          ticketId: served.id,
          kind: attachment.payload.kind,
          ticketUpdatedAt,
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

/** Rebuild the persisted payload shape the server derives from an add input. */
function jsonPayloadFromInput(
  input: Record<string, unknown> & { kind: string },
): TicketAttachmentPayload {
  switch (input.kind) {
    case "conversation":
      return {
        kind: "conversation",
        projectPath: `/home/alex/github/${String(input.projectName)}`,
        sessionName: (input.sessionName as string | null) ?? null,
        conversationId: String(input.conversationId),
        snapshotKey: "ticket-content/t-cc-12/new/compaction.md",
        snapshotCapturedAt: new Date().toISOString(),
      };
    case "session":
      return {
        kind: "session",
        projectPath: `/home/alex/github/${String(input.projectName)}`,
        sessionName: String(input.sessionName),
      };
    case "related_ticket":
      return {
        kind: "related_ticket",
        ticketId: `t-${String(input.projectName)}-${String(input.number)}`,
        identifierSnapshot: formatTicketIdentifier(
          String(input.projectName),
          Number(input.number),
        ),
      };
    default:
      return { kind: "note", markdown: String(input.markdown) };
  }
}

// ---------------------------------------------------------------------------
// Harness components
// ---------------------------------------------------------------------------

function DossierIndex({
  projectName,
  number,
}: {
  projectName: string;
  number: number;
}): React.JSX.Element {
  const detailQuery = useTicketDetailQuery(projectName, number);
  if (!detailQuery.data) {
    return <div>Loading ticket…</div>;
  }
  return (
    <AttachmentIndex
      projectName={projectName}
      number={number}
      attachments={detailQuery.data.attachments}
    />
  );
}

function IndexHarness({
  detail,
  failPosts = 0,
}: {
  detail: TicketDetail;
  failPosts?: number;
}): React.JSX.Element {
  const cleanup = mockAttachmentFetch(detail, { failPosts });
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <div className="mx-auto max-w-[72ch] p-xl">
        <DossierIndex projectName={detail.projectName} number={detail.number} />
      </div>
      <ToastContainer />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/AttachmentIndex",
  component: AttachmentIndex,
  // Stories render through IndexHarness (query-cache-backed, like the app);
  // meta-level args only satisfy the component's required-prop contract.
  args: { projectName: "command-center", number: 12, attachments: ALL_KINDS },
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true },
  },
} satisfies Meta<typeof AttachmentIndex>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * Every attachment kind in one index — entries lead with the description over
 * a kind-tinted icon tile, kind chip, mono metadata, and View/Edit/Remove
 * actions. The ticket is CLOSED: attachment CRUD works in any status.
 */
export const AllKinds: Story = {
  render: () => <IndexHarness detail={makeDetail()} />,
};

/** No context yet — the empty index nudges Add context. */
export const EmptyIndex: Story = {
  render: () => <IndexHarness detail={makeDetail({ attachments: [] })} />,
};

/**
 * View expands the entry in place on the void surface — the note's markdown
 * renders without leaving the dossier.
 */
export const NotePreview: Story = {
  render: () => <IndexHarness detail={makeDetail()} />,
  play: async ({ canvas }) => {
    const entry = await canvas.findByRole("listitem", {
      name: "Constraints agreed with maintainers before starting.",
    });
    await userEvent.click(within(entry).getByRole("button", { name: "View" }));
  },
};

/**
 * The add dialog: SegmentedControl kind picker over the per-kind form, with
 * the required description gating submission.
 */
export const AddDialog: Story = {
  render: () => <IndexHarness detail={makeDetail()} />,
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add context" }),
    );
  },
};

/**
 * A failed file upload leaves NO phantom entry — the pending entry becomes a
 * red panel offering Retry and Discard.
 */
export const FailedFileUpload: Story = {
  render: () => <IndexHarness detail={makeDetail()} failPosts={1} />,
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add context" }),
    );
    const body = within(document.body);
    const fileInput = await body.findByLabelText("File");
    await userEvent.upload(
      fileInput,
      new File(["profile trace"], "trace.json", { type: "application/json" }),
    );
    await userEvent.type(
      await body.findByLabelText("Description"),
      "Startup profile trace from the slow dossier.",
    );
    await userEvent.click(body.getByRole("button", { name: "Attach" }));
  },
};
