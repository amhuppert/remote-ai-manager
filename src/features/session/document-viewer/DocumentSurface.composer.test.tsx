// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      if (method === "POST") {
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
      return jsonResponse({ error: "Agent unavailable" }, 503);
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
  Extract<CommentComposerCapability, { kind: "persist-or-send" }>
> {
  await waitFor(() => expect(capturedComposer).toBeDefined());
  expect(capturedComposer?.kind).toBe("persist-or-send");
  return capturedComposer as Extract<
    CommentComposerCapability,
    { kind: "persist-or-send" }
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

  it("supplies persist-or-send and keeps queue distinct from immediate delivery", async () => {
    renderSurface(makeClient());
    const capability = await composer();

    await capability.submit({
      anchor: ANCHOR,
      note: "queue this",
      delivery: "queue",
    });
    expect(requests.createBodies).toHaveLength(1);
    expect(requests.deliveryBodies).toHaveLength(0);

    await capability.submit({
      anchor: ANCHOR,
      note: "send this",
      delivery: "send",
    });
    expect(requests.createBodies).toHaveLength(2);
    expect(requests.deliveryBodies).toHaveLength(1);
  });

  it("rejects failed persistence so the composer can retain its draft", async () => {
    requests.failNextCreate = true;
    renderSurface(makeClient());
    const capability = await composer();

    await expect(
      capability.submit({
        anchor: ANCHOR,
        note: "retain this",
        delivery: "queue",
      }),
    ).rejects.toThrow("Persistence refused");
    expect(requests.persisted).toHaveLength(0);
  });

  it("resolves after persistence when immediate delivery fails and exposes retry", async () => {
    renderSurface(makeClient());
    const capability = await composer();

    await expect(
      capability.submit({
        anchor: ANCHOR,
        note: "persist before delivery",
        delivery: "send",
      }),
    ).resolves.toBeUndefined();

    expect(requests.persisted).toHaveLength(1);
    expect(
      await screen.findByRole("button", {
        name: "1 pending comment to send",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent unavailable")).toBeInTheDocument();
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
