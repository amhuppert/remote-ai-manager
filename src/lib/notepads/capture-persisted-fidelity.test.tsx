// @vitest-environment jsdom
import React, { createRef } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NotepadEditor,
  type NotepadEditorHandle,
} from "@/components/notepad/NotepadEditor";
import { NotepadPreview } from "@/components/notepad/NotepadPreview";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  installFetchFixture,
  type FetchFixture,
  type RecordedRequest,
  type RouteReply,
} from "@/test/fetch-fixture";
import { createTestQueryClient } from "@/test/component-mocks";

import { buildClipFragment } from "./capture-fragment";
import { useAppendNotepadContentMutation } from "./mutations";
import { useNotepadDetailQuery } from "./queries";
import {
  createNotepadsRouteHandlers,
  type NotepadsRouteHandlers,
  type RouteContext,
} from "./route-handlers";
import { createNotepadService, type NotepadService } from "./service";

/**
 * R22.1's save-and-reload boundary, end to end: what the append composed is
 * byte-for-byte what the repository holds, what the query boundary hands back,
 * and what the editor and preview reopen — with the attribution a chip in both
 * surfaces. Distinct from separator parity, which is about how the two landing
 * paths compose; this is about what survives the round trip.
 */

// Tiptap needs Range measurement APIs jsdom does not implement.
beforeEach(() => {
  if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* () {},
        }) as unknown as DOMRectList;
    }
    if (!Range.prototype.getBoundingClientRect) {
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
    }
  }
});

const PROJECT_PATH = "/repos/p1";
const EXISTING = "Existing notepad content.";

const MESSAGE_REF_XML = buildMessageRefXml({
  projectName: "command-center",
  sessionName: "notepad-slice-3",
  conversationId: "conv-88",
  conversationName: "Capture foundation",
  messageIndex: 4,
  role: "assistant",
  timestamp: "2026-08-31T09:15:00Z",
  model: "opus",
  compaction: null,
});

const BLOCKQUOTE_FRAGMENT = buildClipFragment({
  text: "The destination is shown before content lands.",
  isCode: false,
  provenance: { kind: "ref", xml: MESSAGE_REF_XML },
});

const CODE_FRAGMENT = buildClipFragment({
  text: "if (ready) {\n  land();\n}",
  isCode: true,
  provenance: { kind: "ref", xml: MESSAGE_REF_XML },
});

/** Clipped code that carries a fence of its own — a markdown answer, a doc. */
const NESTED_FENCE_FRAGMENT = buildClipFragment({
  text: "Example:\n\n```js\nland();\n```",
  isCode: true,
  provenance: { kind: "ref", xml: MESSAGE_REF_XML },
});

/** A browser capture sends no bearer token, so it resolves as the user. */
const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken(request) {
    return request.headers.get("authorization") === null
      ? { kind: "absent" }
      : { kind: "invalid" };
  },
};

let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let service: NotepadService;
let handlers: NotepadsRouteHandlers;
let api: FetchFixture;
let queryClient: QueryClient;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  repo = createNotepadsRepo(fixture.db, writeQueue);
  let clock = 0;
  let idSeq = 0;
  service = createNotepadService({
    repo,
    comments: createNotepadCommentsRepo(fixture.db, writeQueue),
    publish: () => ({ delivered: true }),
    deleteNotepadContent: async () => {},
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 31, 9, 0, 0) + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `np-gen-${idSeq}`;
    },
  });
  handlers = createNotepadsRouteHandlers({
    getService: () => service,
    resolveProjectPath: async () => PROJECT_PATH,
    auth,
  });

  api = installFetchFixture();
  api.reply("GET", /^\/api\/notepads\/[^/]+$/, delegate(handlers.detailGET));
  api.reply(
    "POST",
    /^\/api\/notepads\/[^/]+\/content$/,
    delegate(handlers.contentPOST),
  );

  queryClient = createTestQueryClient();
});

afterEach(() => {
  api.restore();
  cleanup();
  fixture.close();
});

/** Carries a fixture-recorded request into a real route handler verbatim. */
function delegate(
  handler: (request: Request, context: RouteContext) => Promise<Response>,
): (req: RecordedRequest) => Promise<RouteReply> {
  return async (req) => {
    const request = new Request(`http://localhost${req.pathname}`, {
      method: req.method,
      ...(req.jsonBody === null
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req.jsonBody),
          }),
    });
    const notepadId = decodeURIComponent(req.pathname.split("/")[3] ?? "");
    const response = await handler(request, {
      params: Promise.resolve({ notepadId }),
    });
    return { status: response.status, json: await response.json() };
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function handleOf<T>(ref: React.RefObject<T | null>): T {
  const handle = ref.current;
  if (handle === null) throw new Error("editor handle was never attached");
  return handle;
}

/** Seed, then land the fragment through the production user content path. */
async function landFragment(
  name: string,
  fragment: string,
): Promise<{ notepadId: string; composed: string }> {
  const created = await service.create({
    scope: "project",
    projectPath: PROJECT_PATH,
    name,
    content: EXISTING,
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error.code}`);
  const notepadId = created.value.id;

  const { result } = renderHook(() => useAppendNotepadContentMutation(), {
    wrapper: Wrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({ notepadId, content: fragment });
  });

  return { notepadId, composed: `${EXISTING}\n\n${fragment}` };
}

/**
 * The content the query boundary hands a reader that holds no write cache.
 *
 * The append mutation seeds the detail cache with its own response, so reading
 * through the writing client would prove nothing about reload — it would hand
 * back the bytes the client already had. A cold client has to fetch the detail
 * route, and that fetch is asserted here so a stale or failing reload cannot
 * pass silently.
 */
async function contentThroughQuery(notepadId: string): Promise<string> {
  const readerClient = createTestQueryClient();
  const detailUrl = `/api/notepads/${notepadId}`;
  const before = api.requestsTo("GET", detailUrl).length;

  const { result } = renderHook(() => useNotepadDetailQuery(notepadId), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={readerClient}>
        {children}
      </QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(api.requestsTo("GET", detailUrl)).toHaveLength(before + 1);
  const content = result.current.data?.content;
  if (content === undefined) throw new Error("the reload returned no notepad");
  return content;
}

const forms = [
  { label: "blockquote", name: "Inbox quotes", fragment: BLOCKQUOTE_FRAGMENT },
  { label: "fenced code", name: "Inbox code", fragment: CODE_FRAGMENT },
];

describe.each(forms)(
  "a landed $label fragment survives save and reload (R22.1)",
  ({ name, fragment }) => {
    it("holds identical canonical bytes in the repository and the query", async () => {
      const { notepadId, composed } = await landFragment(name, fragment);

      expect((await repo.find(notepadId))?.content).toBe(composed);
      expect(await contentThroughQuery(notepadId)).toBe(composed);
    });

    it("reopens in the editor with the bytes intact and the attribution a chip", async () => {
      const { notepadId, composed } = await landFragment(name, fragment);
      const reloaded = await contentThroughQuery(notepadId);

      const ref = createRef<NotepadEditorHandle>();
      const { container } = render(
        <NotepadEditor
          ref={ref}
          notepadId={notepadId}
          initialContent={reloaded}
          onContentChange={() => {}}
        />,
        { wrapper: Wrapper },
      );

      expect(handleOf(ref).serialize()).toBe(composed);
      // The chip is a React node view, so it mounts a tick after the document.
      await waitFor(() =>
        expect(
          container.querySelectorAll("[data-message-mention-chip]"),
        ).toHaveLength(1),
      );
    });

    it("renders in the preview with the attribution a chip", async () => {
      const { notepadId } = await landFragment(name, fragment);
      const reloaded = await contentThroughQuery(notepadId);

      const { findByTestId } = render(
        <NotepadPreview notepadId={notepadId} content={reloaded} />,
        { wrapper: Wrapper },
      );

      const chip = await findByTestId("notepad-preview-chip");
      expect(chip.getAttribute("data-ref-kind")).toBe("message-ref");
    });
  },
);

describe("the quoted structure survives into the preview (R22.1)", () => {
  it("renders a blockquote clip as a blockquote carrying its attribution", async () => {
    const { notepadId } = await landFragment(
      "Inbox quotes",
      BLOCKQUOTE_FRAGMENT,
    );
    const reloaded = await contentThroughQuery(notepadId);

    const { container, findByTestId } = render(
      <NotepadPreview notepadId={notepadId} content={reloaded} />,
      { wrapper: Wrapper },
    );

    await findByTestId("notepad-preview-chip");
    const quote = container.querySelector("blockquote");
    if (quote === null) throw new Error("expected a blockquote");
    expect(quote.textContent).toContain(
      "The destination is shown before content lands.",
    );
    within(quote).getByTestId("notepad-preview-chip");
  });

  it("renders a code clip as a code block with the attribution outside it", async () => {
    const { notepadId } = await landFragment("Inbox code", CODE_FRAGMENT);
    const reloaded = await contentThroughQuery(notepadId);

    const { container, findByTestId } = render(
      <NotepadPreview notepadId={notepadId} content={reloaded} />,
      { wrapper: Wrapper },
    );

    const chip = await findByTestId("notepad-preview-chip");
    const code = container.querySelector("pre code");
    if (code === null) throw new Error("expected a fenced code block");
    expect(code.textContent).toContain("if (ready) {");
    expect(code.contains(chip)).toBe(false);
  });

  it("keeps a code clip that carries its own fence in one block", async () => {
    const { notepadId, composed } = await landFragment(
      "Inbox nested",
      NESTED_FENCE_FRAGMENT,
    );
    const reloaded = await contentThroughQuery(notepadId);
    expect(reloaded).toBe(composed);

    const { container, findByTestId } = render(
      <NotepadPreview notepadId={notepadId} content={reloaded} />,
      { wrapper: Wrapper },
    );

    const chip = await findByTestId("notepad-preview-chip");
    const blocks = container.querySelectorAll("pre code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toContain("```js");
    expect(blocks[0]?.textContent).toContain("land();");
    expect(blocks[0]?.contains(chip)).toBe(false);
  });
});

describe("the reload is the server's answer, not the write cache (R22.1)", () => {
  it("hands back bytes the writing client never saw", async () => {
    const { notepadId, composed } = await landFragment(
      "Inbox drift",
      BLOCKQUOTE_FRAGMENT,
    );
    // A write the client never observed — only a real reload can return it.
    const elsewhere = await service.writeContent(notepadId, {
      operation: "append",
      content: "Landed from elsewhere.",
      author: { kind: "user" },
    });
    if (!elsewhere.ok) {
      throw new Error(`external write failed: ${elsewhere.error.code}`);
    }

    expect(await contentThroughQuery(notepadId)).toBe(
      `${composed}\n\nLanded from elsewhere.`,
    );
  });
});
