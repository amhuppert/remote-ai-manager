// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceMappedDocumentMarkdown } from "@/components/markdown/Markdown";
import type {
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import { findCommentBlock, blockAnnotatableText } from "./anchor-dom";
import {
  resolveComments,
  useDocumentComments,
  type DocumentCommentsState,
} from "./use-document-comments";

//  1: # Title
//  2:
//  3: ## Section Two
//  4:
//  5: Body of section two has a quotable passage inside it.
//  6:
const DOC = [
  "# Title",
  "",
  "## Section Two",
  "",
  "Body of section two has a quotable passage inside it.",
  "",
].join("\n");

function comment(
  over: Partial<DocumentComment> & { id: string },
): DocumentComment {
  return {
    id: over.id,
    projectPath: "/p",
    sessionName: "s",
    docPath: "doc.md",
    anchor: over.anchor ?? {
      sectionId: "section-two",
      headingLabel: "Section Two",
      line: 5,
      charStart: 26,
      charEnd: 42,
      quote: "quotable passage",
      prefix: "",
      suffix: "",
      docRevision: "r1",
    },
    note: over.note ?? "n",
    status: over.status ?? "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: over.status === "sent" ? "2026-01-02T00:00:00.000Z" : null,
  };
}

/**
 * Render the canonical source-mapped document adapter and wait for it to stamp
 * blocks (its renderer is deferred), so the pure re-anchor helpers run against
 * the same rendered DOM the annotated surface produces.
 */
async function renderDoc(): Promise<HTMLElement> {
  const { container } = render(<SourceMappedDocumentMarkdown content={DOC} />);
  await waitFor(
    () => expect(container.querySelector("[data-cc-line]")).not.toBeNull(),
    { timeout: 15000 },
  );
  return container;
}

describe("resolveComments", () => {
  it("anchors a comment whose quote still matches at its stored offsets", async () => {
    const container = await renderDoc();
    const block = findCommentBlock(container, comment({ id: "a" }).anchor)!;
    const text = blockAnnotatableText(block);
    const charStart = text.indexOf("quotable passage");
    const charEnd = charStart + "quotable passage".length;

    const [resolved] = resolveComments(
      [
        comment({
          id: "a",
          anchor: { ...comment({ id: "a" }).anchor, charStart, charEnd },
        }),
      ],
      container,
    );

    expect(resolved?.stale).toBe(false);
    expect(resolved?.reanchor).toEqual({
      status: "anchored",
      charStart,
      charEnd,
    });
  });

  it("marks a comment stale when its quote is gone from the document", async () => {
    const container = await renderDoc();
    const [resolved] = resolveComments(
      [
        comment({
          id: "gone",
          anchor: {
            ...comment({ id: "gone" }).anchor,
            quote: "text that does not exist anywhere",
          },
        }),
      ],
      container,
    );
    expect(resolved?.stale).toBe(true);
    expect(resolved?.reanchor.status).toBe("stale");
  });

  it("marks a comment stale when its block no longer exists", async () => {
    const container = await renderDoc();
    const [resolved] = resolveComments(
      [
        comment({
          id: "x",
          anchor: { ...comment({ id: "x" }).anchor, line: 999 },
        }),
      ],
      container,
    );
    expect(resolved?.stale).toBe(true);
  });

  it("re-anchors to the live offset when the passage shifted within its block", async () => {
    // Stored offsets are wrong (point at the start of the block) but the quote
    // is present nearby — re-anchoring must report the CURRENT rendered offset,
    // not the stored one, so the highlight lands on the real passage.
    const container = await renderDoc();
    const [resolved] = resolveComments(
      [
        comment({
          id: "shift",
          anchor: {
            ...comment({ id: "shift" }).anchor,
            charStart: 0,
            charEnd: 8,
            quote: "quotable",
          },
        }),
      ],
      container,
    );
    expect(resolved?.reanchor).toEqual({
      status: "anchored",
      charStart: 26,
      charEnd: 34,
    });
  });

  it("marks every comment stale when the content has not rendered yet", () => {
    const resolved = resolveComments([comment({ id: "a" })], null);
    expect(resolved.every((c) => c.stale)).toBe(true);
  });
});

// ── Hook ────────────────────────────────────────────────────────────────────

/**
 * Drives the hook over a ref'd container whose stamped block only appears AFTER
 * the initial render — mirroring the canonical renderer, which defers its real
 * DOM behind a fallback and stamps blocks a tick later. The hook must re-anchor
 * when those blocks appear, so a comment resolved before the render finishes
 * does not stay permanently stale.
 */
function DeferredRenderHarness({
  onState,
  rendered,
}: {
  onState: (state: DocumentCommentsState) => void;
  rendered: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDocumentComments({
    docRef: DOC_REF,
    content: DOC,
    contentRef: ref,
  });
  onState(state);
  return (
    <div ref={ref}>
      {rendered ? (
        <p
          data-cc-line="5"
          data-cc-section="section-two"
          data-cc-heading="Section Two"
        >
          Body of section two has a quotable passage inside it.
        </p>
      ) : null}
    </div>
  );
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const DOC_REF: DocumentRef = {
  projectName: "proj",
  sessionName: "sess",
  docPath: "doc.md",
  title: "Doc",
};

/**
 * Renders the real (deferred) source-mapped document into a ref'd container and
 * drives the hook over it, exposing the latest hook state via `onState` so
 * assertions read resolved, re-anchored output (not a hand-rolled fake). Because
 * the canonical renderer stamps blocks asynchronously, this also exercises that
 * the hook re-anchors once the rendered DOM appears.
 */
function HookHarness({
  docRef,
  onState,
}: {
  docRef: DocumentRef | null;
  onState: (state: DocumentCommentsState) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDocumentComments({
    docRef,
    content: docRef ? DOC : null,
    contentRef: ref,
  });
  onState(state);
  return (
    <div ref={ref}>
      {docRef ? <SourceMappedDocumentMarkdown content={DOC} /> : null}
    </div>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useDocumentComments", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the document's comment count and resolves anchored vs stale", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        comment({ id: "anchored", status: "pending" }),
        comment({
          id: "stale",
          status: "sent",
          anchor: {
            ...comment({ id: "stale" }).anchor,
            quote: "gone from the document",
          },
        }),
      ]),
    );

    let latest: DocumentCommentsState | undefined;
    render(<HookHarness docRef={DOC_REF} onState={(s) => (latest = s)} />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={makeClient()}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(latest?.commentCount).toBe(2));
    await waitFor(() =>
      expect(latest?.comments.map((c) => c.id).sort()).toEqual([
        "anchored",
        "stale",
      ]),
    );

    // The anchored comment must resolve non-stale once the deferred renderer has
    // stamped the block — the hook re-anchors when the rendered DOM appears.
    await waitFor(() => {
      const byId = new Map(latest!.comments.map((c) => [c.id, c]));
      expect(byId.get("anchored")?.stale).toBe(false);
      expect(byId.get("stale")?.stale).toBe(true);
    });
  });

  it("splits out pending comments and groups anchored comments by block", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        comment({ id: "p", status: "pending" }),
        comment({ id: "s", status: "sent" }),
      ]),
    );

    let latest: DocumentCommentsState | undefined;
    render(<HookHarness docRef={DOC_REF} onState={(s) => (latest = s)} />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={makeClient()}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(latest?.commentCount).toBe(2));
    await waitFor(() => expect(latest?.pendingComments).toHaveLength(1));
    expect(latest?.pendingComments[0]?.id).toBe("p");
    // both anchored to the same block (line 5) → one gutter group of count 2
    await waitFor(() => expect(latest?.anchoredGroups).toHaveLength(1));
    expect(latest?.anchoredGroups[0]?.count).toBe(2);
    // any pending in the block → the group reads pending
    expect(latest?.anchoredGroups[0]?.status).toBe("pending");
  });

  it("re-anchors comments when the deferred render stamps blocks after mount", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([comment({ id: "anchored", status: "pending" })]),
    );

    let latest: DocumentCommentsState | undefined;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={makeClient()}>
        {children}
      </QueryClientProvider>
    );
    const { rerender } = render(
      <DeferredRenderHarness rendered={false} onState={(s) => (latest = s)} />,
      { wrapper },
    );

    // Comment loads while the block is not yet stamped → resolves stale.
    await waitFor(() => expect(latest?.commentCount).toBe(1));
    await waitFor(() => expect(latest?.comments[0]?.stale).toBe(true));

    // The deferred renderer stamps the block — the hook must re-anchor without
    // any change to the comments query or content props.
    rerender(
      <DeferredRenderHarness rendered={true} onState={(s) => (latest = s)} />,
    );

    await waitFor(() => expect(latest?.comments[0]?.stale).toBe(false));
    expect(latest?.anchoredGroups).toHaveLength(1);
  });

  it("reports zero comments and never fetches when no document is active", async () => {
    let latest: DocumentCommentsState | undefined;
    render(<HookHarness docRef={null} onState={(s) => (latest = s)} />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={makeClient()}>
          {children}
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(latest).toBeDefined());
    expect(latest?.commentCount).toBe(0);
    expect(latest?.comments).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
