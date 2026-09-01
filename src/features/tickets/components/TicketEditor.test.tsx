// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  pastedImageDescription,
  pastedImageFileName,
} from "@/lib/tickets/description-images";
import type { TicketAttachment, TicketDetail } from "@/lib/tickets/schemas";
import { TicketDescriptionEditor, TicketTitleEditor } from "./TicketEditor";

const DETAIL: TicketDetail = {
  id: "ticket-1",
  projectPath: "/repos/alpha",
  projectName: "alpha",
  number: 1,
  title: "Original",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  attachments: [],
  sessions: [],
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

// Tiptap needs DOM measurement APIs jsdom does not implement.
beforeAll(() => {
  document.elementFromPoint = () => document.body;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  URL.createObjectURL = () => "blob:ticket-editor-test";
  URL.revokeObjectURL = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketTitleEditor mutation feedback", () => {
  it("retains the first failure when a second save is queued", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") throw new Error("Unexpected request");
      return new Promise<Response>((resolve) => patchResolvers.push(resolve));
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <TicketTitleEditor projectName="alpha" number={1} title="Original" />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    const saveTitle = async (title: string) => {
      await user.click(screen.getByRole("heading", { name: "Original" }));
      const input = screen.getByRole("textbox", { name: "Ticket title" });
      await user.clear(input);
      await user.type(input, title);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("heading", { name: "Original" });
    };
    await saveTitle("First save");
    await saveTitle("Second save");
    await waitFor(() => expect(patchResolvers).toHaveLength(1));

    await act(async () => {
      patchResolvers[0]!(
        Response.json({ error: "first failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(patchResolvers).toHaveLength(2));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");

    await act(async () => {
      patchResolvers[1]!(
        Response.json({
          ...DETAIL,
          title: "Second save",
          updatedAt: "2026-07-01T00:00:01.000Z",
        }),
      );
      await Promise.resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// Description editor
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  body: RequestInit["body"];
}

/**
 * Route fetch by method+url. Unmatched GETs fail softly (background queries
 * like voice health or editor capability probes are not under test);
 * unmatched mutations throw so no write escapes the assertions.
 */
function stubRoutedFetch(
  routes: Array<{
    method: string;
    match: (url: string) => boolean;
    respond: (init: RequestInit | undefined, url: string) => Response;
  }>,
): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? "GET").toUpperCase();
      const route = routes.find(
        (candidate) => candidate.method === method && candidate.match(url),
      );
      if (route === undefined) {
        if (method === "GET") {
          return Response.json({ error: "not under test" }, { status: 500 });
        }
        throw new Error(`Unexpected ${method} ${url}`);
      }
      recorded.push({ method, url, body: init?.body });
      return route.respond(init, url);
    },
  );
  return recorded;
}

function makeImageFile(name = "shot.png"): File {
  return new File(["payload"], name, { type: "image/png" });
}

function buildClipboard(files: File[]): {
  items: DataTransferItem[];
  files: File[];
  getData: () => string;
  types: string[];
} {
  const items = files.map(
    (f) =>
      ({
        kind: "file",
        type: f.type,
        getAsFile: () => f,
      }) as unknown as DataTransferItem,
  );
  return { items, files, getData: () => "", types: [] };
}

const PASTED_ATTACHMENT: TicketAttachment = {
  id: "att-img-1",
  ticketId: "ticket-1",
  description: pastedImageDescription(1),
  payload: {
    kind: "file",
    fileName: pastedImageFileName(1, "image/png"),
    snapshotKey: "snap-att-img-1",
    mediaType: "image/png",
    sizeBytes: 7,
    sha256: "sha-1",
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const CREATED_ATTACHMENT: TicketAttachment = {
  ...PASTED_ATTACHMENT,
  id: "att-created",
};

function renderDescriptionEditor(
  description: string,
  attachments: TicketAttachment[] = [],
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <TicketDescriptionEditor
        projectName="alpha"
        number={1}
        description={description}
        attachments={attachments}
      />
    </QueryClientProvider>,
  );
}

describe("TicketDescriptionEditor preview", () => {
  it("renders the description through the canonical document adapter", async () => {
    renderDescriptionEditor("## Rollout plan\n\nShip the migration.");

    const heading = await screen.findByRole("heading", {
      name: "Rollout plan",
    });
    expect(heading.tagName).toBe("H2");
    // DocumentMarkdown stamps a document-intent root; this pins that the host
    // renders through the canonical document adapter.
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
    // Raw markdown markers must not leak into the rendered output.
    expect(screen.queryByText(/## Rollout plan/)).not.toBeInTheDocument();
  });

  it("swaps the preview for the rich editor on Edit and restores it on Cancel", async () => {
    renderDescriptionEditor("## Rollout plan\n\nShip the migration.");
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Rollout plan" });
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByTestId("prompt-input");
    expect(editor).toHaveTextContent("## Rollout plan");
    expect(
      screen.queryByRole("heading", { name: "Rollout plan" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("heading", { name: "Rollout plan" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-input")).not.toBeInTheDocument();
  });

  it("persists an edited description through the update mutation on Save", async () => {
    const recorded = stubRoutedFetch([
      {
        method: "PATCH",
        match: (url) => url.endsWith("/tickets/1"),
        respond: () => Response.json({ ...DETAIL, description: "Rewritten." }),
      },
    ]);
    renderDescriptionEditor("");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByTestId("prompt-input");
    await user.click(editor);
    await user.type(editor, "Rewritten.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(recorded.filter((r) => r.method === "PATCH")).toHaveLength(1),
    );
    expect(String(recorded[0]!.body)).toContain("Rewritten.");
    await waitFor(() =>
      expect(screen.queryByTestId("prompt-input")).not.toBeInTheDocument(),
    );
  });
});

describe("TicketDescriptionEditor pasted images", () => {
  it("uploads a pasted image as a linked attachment before saving the reference", async () => {
    const recorded = stubRoutedFetch([
      {
        method: "POST",
        match: (url) => url.endsWith("/tickets/1/attachments"),
        respond: () => Response.json(CREATED_ATTACHMENT),
      },
      {
        method: "PATCH",
        match: (url) => url.endsWith("/tickets/1"),
        respond: () => Response.json(DETAIL),
      },
    ]);
    renderDescriptionEditor("");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByTestId("prompt-input");
    await user.click(editor);
    await user.type(editor, "See ");
    fireEvent.paste(editor, {
      clipboardData: buildClipboard([makeImageFile()]),
    });
    await screen.findByText("#1");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(recorded.map((request) => request.method)).toEqual([
        "POST",
        "PATCH",
      ]),
    );
    const upload = recorded[0]!;
    expect(upload.body).toBeInstanceOf(FormData);
    const form = upload.body as FormData;
    const metadata = JSON.parse(String(form.get("metadata"))) as {
      description: string;
      fileName: string;
      mediaType: string;
    };
    expect(metadata.description).toBe(pastedImageDescription(1));
    expect(metadata.fileName).toBe("pasted-image-1.png");
    expect(metadata.mediaType).toBe("image/png");
    expect(form.get("file")).toBeInstanceOf(File);

    const patchBody = String(recorded[1]!.body);
    expect(patchBody).toContain("[Image #1]");
    expect(patchBody).toContain("See ");
  });

  it("hydrates existing pasted images and deletes de-referenced attachments after saving", async () => {
    const recorded = stubRoutedFetch([
      {
        method: "GET",
        match: (url) => url.endsWith("/tickets/1/attachments/att-img-1"),
        respond: () =>
          Response.json({
            kind: "file",
            attachment: PASTED_ATTACHMENT,
            fileName:
              PASTED_ATTACHMENT.payload.kind === "file"
                ? PASTED_ATTACHMENT.payload.fileName
                : "pasted-image-1.png",
            mediaType: "image/png",
            sizeBytes: 7,
            sha256: "sha-1",
            encoding: "base64",
            content: btoa("payload"),
          }),
      },
      {
        method: "PATCH",
        match: (url) => url.endsWith("/tickets/1"),
        respond: () =>
          Response.json({ ...DETAIL, description: "Before after" }),
      },
      {
        method: "DELETE",
        match: (url) => url.endsWith("/tickets/1/attachments/att-img-1"),
        respond: () =>
          Response.json({
            attachmentId: "att-img-1",
            ticketId: "ticket-1",
            kind: "file",
            ticketUpdatedAt: "2026-07-01T00:00:02.000Z",
          }),
      },
    ]);
    renderDescriptionEditor("Before [Image #1] after", [PASTED_ATTACHMENT]);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    // The chip hydrates from the resolved attachment bytes.
    await screen.findByText("#1");

    await user.click(screen.getByRole("button", { name: "Remove image" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(recorded.map((request) => request.method)).toEqual([
        "GET",
        "PATCH",
        "DELETE",
      ]),
    );
    const patchBody = String(recorded[1]!.body);
    expect(patchBody).not.toContain("[Image #1]");
    expect(recorded[2]!.url).toContain("/attachments/att-img-1");
  });
});
