// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ticketKeys } from "@/lib/tickets/query-keys";
import { useTicketDetailQuery } from "@/lib/tickets/queries";
import type {
  ResolvedAttachment,
  TicketAttachment,
  TicketDetail,
} from "@/lib/tickets/schemas";
import { useToastStoreForTesting } from "@/stores/toast.store";
import AttachmentIndex from "./AttachmentIndex";

const DETAIL: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Attachment callback lifetime",
  description: "",
  workType: "bug",
  status: "in_progress",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [
    {
      id: "attachment-1",
      ticketId: "ticket-12",
      description: "Failure report",
      payload: { kind: "note", markdown: "## Failure" },
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    },
  ],
  sessions: [],
};

function CacheBackedIndex(): React.JSX.Element | null {
  const detail = useTicketDetailQuery("command-center", 12).data;
  if (!detail) return null;
  return (
    <AttachmentIndex
      projectName={detail.projectName}
      number={detail.number}
      attachments={detail.attachments}
    />
  );
}

function renderIndex() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(ticketKeys.detail("command-center", 12), DETAIL);
  return render(
    <QueryClientProvider client={queryClient}>
      <CacheBackedIndex />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useToastStoreForTesting.setState({ toasts: [] });
});

describe("AttachmentIndex mutation feedback", () => {
  it("reports a removal failure after the optimistic removal unmounts its entry", async () => {
    let resolveDelete: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") {
        throw new Error("Unexpected attachment request");
      }
      return new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    });
    renderIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    await user.click(within(entry).getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("listitem", { name: "Failure report" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(resolveDelete).not.toBeNull());

    await act(async () => {
      resolveDelete!(
        Response.json({ error: "remove failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't remove")),
      ).toBe(true),
    );
  });

  it("reports an edit failure after Save closes and unmounts the edit form", async () => {
    let resolvePatch: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        throw new Error("Unexpected attachment request");
      }
      return new Promise<Response>((resolve) => {
        resolvePatch = resolve;
      });
    });
    renderIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    await user.click(within(entry).getByRole("button", { name: "Edit" }));
    await user.clear(await within(entry).findByLabelText("Description"));
    await user.type(within(entry).getByLabelText("Description"), "Retitled");
    await user.click(within(entry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(resolvePatch).not.toBeNull());
    expect(
      within(entry).queryByLabelText("Description"),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolvePatch!(Response.json({ error: "edit failed" }, { status: 500 }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't save")),
      ).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown preview surfaces — note and captured-conversation/compaction
// content must render through the canonical DocumentMarkdown adapter while the
// host keeps ownership of the expand/collapse controls and metadata labels.
// ---------------------------------------------------------------------------

const NOTE_ATTACHMENT: TicketAttachment = {
  id: "note-1",
  ticketId: "ticket-12",
  description: "Failure report",
  payload: { kind: "note", markdown: "## Failure recap\n\nStack trace body." },
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
};

const CONVERSATION_ATTACHMENT: TicketAttachment = {
  id: "conv-1",
  ticketId: "ticket-12",
  description: "Compaction snapshot",
  payload: {
    kind: "conversation",
    projectPath: "/repos/command-center",
    sessionName: "csm/design-collab",
    conversationId: "conv-abc123",
    snapshotKey: "ticket-content/ticket-12/conv-1/snapshot.md",
    snapshotCapturedAt: "2026-07-11T10:00:00.000Z",
  },
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
};

const NOTE_RESOLVED: ResolvedAttachment = {
  kind: "note",
  attachment: NOTE_ATTACHMENT,
  markdown: "## Failure recap\n\nStack trace body.",
};

const CONVERSATION_RESOLVED: ResolvedAttachment = {
  kind: "conversation",
  attachment: CONVERSATION_ATTACHMENT,
  conversationId: "conv-abc123",
  sessionName: "csm/design-collab",
  source: "retained_compaction",
  sourceAvailable: true,
  markdown: "## Compaction recap\n\nDecisions captured at compaction time.",
  capturedAt: "2026-07-11T10:00:00.000Z",
  readCommands: [],
};

function renderPreviewIndex() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(ticketKeys.detail("command-center", 12), {
    ...DETAIL,
    attachments: [NOTE_ATTACHMENT, CONVERSATION_ATTACHMENT],
  });
  queryClient.setQueryData(
    ticketKeys.attachmentResolve("command-center", 12, NOTE_ATTACHMENT.id),
    NOTE_RESOLVED,
  );
  queryClient.setQueryData(
    ticketKeys.attachmentResolve(
      "command-center",
      12,
      CONVERSATION_ATTACHMENT.id,
    ),
    CONVERSATION_RESOLVED,
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <CacheBackedIndex />
    </QueryClientProvider>,
  );
}

describe("AttachmentIndex markdown previews", () => {
  it("renders a note preview through the canonical document adapter", async () => {
    renderPreviewIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    await user.click(within(entry).getByRole("button", { name: "View" }));

    const heading = await within(entry).findByRole("heading", {
      name: "Failure recap",
    });
    expect(heading.tagName).toBe("H2");
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
  });

  it("renders a captured-conversation compaction preview through the document adapter and keeps the host label", async () => {
    renderPreviewIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Compaction snapshot",
    });
    await user.click(within(entry).getByRole("button", { name: "View" }));

    const heading = await within(entry).findByRole("heading", {
      name: "Compaction recap",
    });
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
    // The host owns the compaction provenance label alongside the adapter.
    expect(within(entry).getByText(/retained compaction/)).toBeInTheDocument();
  });

  it("collapses the note preview when View is toggled again", async () => {
    renderPreviewIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    const view = within(entry).getByRole("button", { name: "View" });
    await user.click(view);
    await within(entry).findByRole("heading", { name: "Failure recap" });

    await user.click(view);
    await waitFor(() =>
      expect(
        within(entry).queryByRole("heading", { name: "Failure recap" }),
      ).not.toBeInTheDocument(),
    );
  });
});
