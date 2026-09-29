// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClipCaptureCapability,
  ClipSelectionContext,
  CommentComposerCapability,
  PersistCommentInput,
} from "@/components/document-viewer/annotation-contract";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import { useSessionDetailStore } from "@/stores/session-detail.store";

import type { AnnotatedMarkdownProps } from "./AnnotatedMarkdown";
import DocumentSurface, {
  _resetAnnotationSurfaceForTesting,
  _setAnnotationSurfaceForTesting,
} from "./DocumentSurface";

const ANCHOR = {
  sectionId: "overview",
  headingLabel: "Overview",
  line: 3,
  charStart: 0,
  charEnd: 16,
  quote: "durable feedback",
  prefix: "",
  suffix: "",
  docRevision: "revision-1",
};

let capturedComposer: CommentComposerCapability | undefined;
let capturedClip: ClipCaptureCapability | undefined;

function CapturingAnnotationSurface({
  composer,
  clip,
}: AnnotatedMarkdownProps): React.JSX.Element {
  useEffect(() => {
    capturedComposer = composer;
    capturedClip = clip;
  }, [composer, clip]);
  return <div data-testid="annotation-surface" />;
}

/** A selection as the seam describes it to a host capability. */
function selectionIn(html: string, text: string): ClipSelectionContext {
  const host = document.createElement("div");
  host.innerHTML = html;
  const block = host.firstElementChild;
  if (!(block instanceof HTMLElement)) throw new Error("no block rendered");
  // A range over the deepest text node holding `text`, as a browser resolves a
  // real selection — the block alone cannot answer inline-code ancestry.
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null && !(node.textContent ?? "").includes(text)) {
    node = walker.nextNode();
  }
  if (node === null) throw new Error(`no text node holds ${text}`);
  const at = (node.textContent ?? "").indexOf(text);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + text.length);
  return { anchor: { ...ANCHOR, quote: text }, text, block, range };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createdComment(
  id: string,
  input: PersistCommentInput,
): DocumentComment {
  return {
    id,
    projectPath: "/project",
    sessionName: "session",
    docPath: "doc.md",
    anchor: input.anchor,
    note: input.note,
    status: "pending",
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
    sentAt: null,
  };
}

interface RequestHarness {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  createBodies: PersistCommentInput[];
  deliveryBodies: unknown[];
  persisted: DocumentComment[];
  failNextCreate: boolean;
  failDelete?: boolean;
  remove?: (id: string) => Promise<void>;
  deliver?: () => Promise<Response>;
  create?: () => Promise<void>;
}

function requestHarness(): RequestHarness {
  const harness: RequestHarness = {
    fetch: vi.fn<typeof fetch>(),
    createBodies: [],
    deliveryBodies: [],
    persisted: [],
    failNextCreate: false,
  };
  harness.fetch.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/document-comments")) {
      if (method === "GET") return jsonResponse(harness.persisted);
      if (method === "DELETE") {
        const id = url.split("/").at(-1) ?? "";
        await harness.remove?.(id);
        if (harness.failDelete)
          return jsonResponse({ error: "Could not remove comment" }, 503);
        harness.persisted = harness.persisted.filter((c) => c.id !== id);
        return jsonResponse({ success: true });
      }
      if (method === "POST") {
        await harness.create?.();
        if (harness.failNextCreate) {
          harness.failNextCreate = false;
          return jsonResponse({ error: "Persistence refused" }, 409);
        }
        const body = JSON.parse(String(init?.body)) as PersistCommentInput & {
          docPath: string;
        };
        const comment = createdComment(
          `comment-${harness.createBodies.length + 1}`,
          body,
        );
        harness.createBodies.push({ anchor: body.anchor, note: body.note });
        harness.persisted.push(comment);
        return jsonResponse(comment);
      }
    }

    if (url.startsWith("/api/conversations/all")) {
      return jsonResponse({ items: [], totalCount: 0 });
    }

    if (method === "POST" && url.endsWith("/prompt")) {
      harness.deliveryBodies.push(JSON.parse(String(init?.body)));
      return harness.deliver
        ? harness.deliver()
        : jsonResponse({ error: "Agent unavailable" }, 503);
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return harness;
}

function renderSurface(client: QueryClient): void {
  render(
    <QueryClientProvider client={client}>
      <DocumentSurface
        docRef={{
          projectName: "project",
          sessionName: "session",
          docPath: "doc.md",
          title: "Document",
        }}
        content={"# Overview\n\ndurable feedback"}
        isLoading={false}
      />
    </QueryClientProvider>,
  );
}

async function composer(): Promise<
  Extract<CommentComposerCapability, { kind: "persist-only" }>
> {
  await waitFor(() => expect(capturedComposer).toBeDefined());
  expect(capturedComposer?.kind).toBe("persist-only");
  return capturedComposer as Extract<
    CommentComposerCapability,
    { kind: "persist-only" }
  >;
}

describe("DocumentSurface composer", () => {
  let requests: RequestHarness;

  beforeEach(() => {
    capturedComposer = undefined;
    capturedClip = undefined;
    requests = requestHarness();
    vi.stubGlobal("fetch", requests.fetch);
    useSessionDetailStore.getState().resetStore();
    _setAnnotationSurfaceForTesting(CapturingAnnotationSurface);
  });

  afterEach(() => {
    cleanup();
    _resetAnnotationSurfaceForTesting();
    vi.unstubAllGlobals();
  });

  it("persists comments to the tray without delivering them", async () => {
    renderSurface(makeClient());
    const capability = await composer();
    await capability.submit({ anchor: ANCHOR, note: "queue this" });
    expect(requests.createBodies).toHaveLength(1);
    expect(requests.deliveryBodies).toHaveLength(0);
    expect(
      await screen.findByRole("button", { name: "1 pending comment to send" }),
    ).toBeInTheDocument();
  });

  it("uses the selected comment's note when switching edit cards with the keyboard", async () => {
    const user = userEvent.setup();
    renderSurface(makeClient());
    const capability = await composer();
    await act(async () => {
      await capability.submit({ anchor: ANCHOR, note: "first comment" });
      await capability.submit({ anchor: ANCHOR, note: "second comment" });
    });
    await user.click(
      await screen.findByRole("button", { name: "2 pending comments to send" }),
    );
    const [firstEdit, secondEdit] = screen.getAllByRole("button", {
      name: "Edit comment",
    });
    if (!firstEdit || !secondEdit) throw new Error("Expected two comment rows");
    await user.click(firstEdit);
    const note = screen.getByRole("textbox", { name: "Edit comment note" });
    await user.clear(note);
    await user.type(note, "unsaved first draft");

    secondEdit.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("textbox", { name: "Edit comment note" }),
    ).toHaveValue("second comment");
  });

  it("disables tray actions during delivery and clears the pending tray after success", async () => {
    let finish: ((response: Response) => void) | undefined;
    requests.deliver = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    renderSurface(makeClient());
    const capability = await composer();
    await act(async () =>
      capability.submit({ anchor: ANCHOR, note: "send once" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Send 1 to agent/ }),
    );
    expect(screen.getByRole("button", { name: /Sending/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    await act(async () => finish?.(jsonResponse({ success: true })));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Pending comments" }),
      ).not.toBeInTheDocument(),
    );
    expect(requests.persisted).toHaveLength(0);
    expect(requests.deliveryBodies).toHaveLength(1);
    expect(screen.queryByText("Sending feedback…")).not.toBeInTheDocument();
  });

  it("does not send an optimistic comment while it is still saving", async () => {
    let finish: (() => void) | undefined;
    requests.create = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    renderSurface(makeClient());
    const capability = await composer();
    let creation: Promise<void> | undefined;
    act(() => {
      creation = capability.submit({ anchor: ANCHOR, note: "still saving" });
    });
    expect(
      await screen.findByRole("button", { name: /Send 1 to agent/ }),
    ).toBeDisabled();
    await act(async () => {
      finish?.();
      await creation;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Send 1 to agent/ }),
      ).toBeEnabled(),
    );
    expect(requests.deliveryBodies).toHaveLength(0);
  });

  it("reports a failed tray clear and restores comments for retry", async () => {
    requests.failDelete = true;
    renderSurface(makeClient());
    const capability = await composer();
    await act(async () =>
      capability.submit({ anchor: ANCHOR, note: "keep on failure" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not remove comment",
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(requests.persisted).toHaveLength(1);
  });

  it("keeps the tray disabled until every deletion in a clear finishes", async () => {
    const firstDeletion = Promise.withResolvers<void>();
    requests.remove = async (id) => {
      if (id === "comment-1") await firstDeletion.promise;
    };
    renderSurface(makeClient());
    const capability = await composer();
    await act(async () => {
      await capability.submit({ anchor: ANCHOR, note: "first comment" });
      await capability.submit({ anchor: ANCHOR, note: "second comment" });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(requests.persisted).toHaveLength(1));
    expect(
      await screen.findByRole("button", { name: /Send 1 to agent/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();

    await act(async () => firstDeletion.resolve());
    await waitFor(() => expect(requests.persisted).toHaveLength(0));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Pending comments" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("reports an earlier clear failure even when the last deletion succeeds", async () => {
    const firstDeletion = Promise.withResolvers<void>();
    requests.remove = async (id) => {
      if (id === "comment-1") await firstDeletion.promise;
    };
    renderSurface(makeClient());
    const capability = await composer();
    await act(async () => {
      await capability.submit({ anchor: ANCHOR, note: "first comment" });
      await capability.submit({ anchor: ANCHOR, note: "second comment" });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(requests.persisted).toHaveLength(1));
    await act(async () =>
      firstDeletion.reject(new Error("First comment could not be removed")),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "First comment could not be removed",
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(requests.persisted).toHaveLength(1);
    delete requests.remove;
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(requests.persisted).toHaveLength(0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects failed persistence so the composer can retain its draft", async () => {
    requests.failNextCreate = true;
    renderSurface(makeClient());
    const capability = await composer();

    await expect(
      capability.submit({
        anchor: ANCHOR,
        note: "retain this",
      }),
    ).rejects.toThrow("Persistence refused");
    expect(requests.persisted).toHaveLength(0);
  });

  it("retains pending comments when delivery from the tray fails", async () => {
    renderSurface(makeClient());
    const capability = await composer();

    await expect(
      capability.submit({
        anchor: ANCHOR,
        note: "persist before delivery",
      }),
    ).resolves.toBeUndefined();

    expect(requests.persisted).toHaveLength(1);
    expect(
      await screen.findByRole("button", {
        name: "1 pending comment to send",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: /Send 1 to agent/ }),
    );
    expect(await screen.findByText("Agent unavailable")).toBeInTheDocument();
  });
});

describe("DocumentSurface clip provenance", () => {
  beforeEach(() => {
    capturedComposer = undefined;
    capturedClip = undefined;
    vi.stubGlobal("fetch", requestHarness().fetch);
    useSessionDetailStore.getState().resetStore();
    _setAnnotationSurfaceForTesting(CapturingAnnotationSurface);
  });

  afterEach(() => {
    cleanup();
    _resetAnnotationSurfaceForTesting();
    vi.unstubAllGlobals();
  });

  it("supplies the document's repo-relative path as clip provenance", async () => {
    renderSurface(makeClient());
    await waitFor(() => expect(capturedClip).toBeDefined());

    const clip = capturedClip;
    if (clip === undefined) throw new Error("no clip capability supplied");

    const selection = selectionIn(
      "<p>durable feedback</p>",
      "durable feedback",
    );
    expect(clip.enabled).toBe(true);
    expect(clip.buildProvenance(selection)).toEqual({
      kind: "path",
      path: "doc.md",
    });
    expect(clip.deriveIsCode(selection)).toBe(false);
    expect(
      clip.deriveIsCode(
        selectionIn(
          `<div data-markdown-code-block><pre><code>bun run dev</code></pre></div>`,
          "bun run dev",
        ),
      ),
    ).toBe(true);
    expect(
      buildClipFragment({
        text: selection.text,
        isCode: clip.deriveIsCode(selection),
        provenance: clip.buildProvenance(selection),
      }),
    ).toBe("> durable feedback\n— doc.md");
  });
});
