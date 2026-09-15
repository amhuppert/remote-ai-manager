// @vitest-environment jsdom
import React, { useRef } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findMessageRefs } from "@/lib/conversations/ref-parser";
import { messageRefAttrsSchema } from "@/lib/conversations/schemas";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { createTestQueryClient } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import TranscriptClipCapture from "./TranscriptClipCapture";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const ARTIFACTS_PATH =
  "/api/projects/p1/sessions/s1/conversations/c1/context-artifacts";

const NOTEPAD_ROW = {
  id: "np-1",
  scope: "project",
  projectPath: "/repos/p1",
  projectName: "p1",
  name: "capture target",
  revision: 1,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

let api: FetchFixture;
let queryClient: QueryClient;

beforeEach(() => {
  api = installFetchFixture();
  queryClient = createTestQueryClient();
  useSessionDetailStore.getState().resetStore();
  useToastStoreForTesting.setState({ toasts: [] });
  api.json("GET", ARTIFACTS_PATH, []);
  api.json("GET", /^\/api\/notepads\?project=p1&sort=recency&archived=true$/, {
    notepads: [NOTEPAD_ROW],
  });
  api.reply("POST", "/api/notepads/np-1/content", {
    json: { notepad: { ...NOTEPAD_ROW, content: "landed", revision: 2 } },
  });
});
afterEach(() => {
  api.restore();
  cleanup();
  vi.restoreAllMocks();
});

/** A transcript-shaped DOM carrying MessageRow's clip-source stamps. */
function TranscriptFixture(): React.JSX.Element {
  return (
    <div className="conversation" data-testid="surface-root">
      <div className="message">
        <div
          className="message-content"
          data-clip-index="0"
          data-clip-role="assistant"
          data-clip-timestamp="2026-08-31T10:00:00.000Z"
          data-clip-model="opus"
        >
          <p data-testid="prose-0">Alpha prose worth clipping.</p>
          <pre data-testid="code-0">
            <code>const answer = 42;</code>
          </pre>
        </div>
      </div>
      <div className="message">
        <div className="message-role">You · 10:01</div>
        <div
          className="message-content"
          data-clip-index="1"
          data-clip-role="user"
        >
          <p data-testid="prose-1">Bravo message text.</p>
        </div>
        <button type="button">Copy reference</button>
      </div>
    </div>
  );
}

function Harness({
  scoped,
}: {
  scoped: "containing" | "elsewhere";
}): React.JSX.Element {
  const containing = useRef<HTMLDivElement | null>(null);
  const elsewhere = useRef<HTMLDivElement | null>(null);
  return (
    <QueryClientProvider client={queryClient}>
      <TranscriptClipCapture
        target={target}
        conversationName="Refactor parser"
        within={scoped === "containing" ? containing : elsewhere}
      />
      <div ref={containing}>
        <TranscriptFixture />
      </div>
      <div ref={elsewhere} data-testid="other-surface" />
    </QueryClientProvider>
  );
}

function renderCapture(scoped: "containing" | "elsewhere" = "containing") {
  return render(<Harness scoped={scoped} />);
}

/** jsdom's Range lacks the rect APIs the trigger placement reads. */
function withRect(range: Range): Range {
  range.getBoundingClientRect = () =>
    ({
      bottom: 120,
      left: 40,
      top: 100,
      right: 240,
      width: 200,
      height: 20,
      x: 40,
      y: 100,
      toJSON: () => ({}),
    }) as DOMRect;
  return range;
}

function stubSelection(range: Range | null): void {
  if (range) withRect(range);
  const selection = {
    isCollapsed: range === null,
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range as Range,
    removeAllRanges: vi.fn(),
    toString: () => (range ? range.toString() : ""),
  };
  vi.spyOn(window, "getSelection").mockReturnValue(
    selection as unknown as Selection,
  );
}

function rangeOverText(element: Element, start: number, end: number): Range {
  const textNode = element.childNodes[0];
  if (!textNode) throw new Error("fixture element has no text node");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  return range;
}

function selectAndClip(range: Range): void {
  stubSelection(range);
  act(() => {
    fireEvent.pointerUp(document);
  });
  fireEvent.click(screen.getByRole("button", { name: "Clip" }));
}

function appendBodies(): unknown[] {
  return api
    .requestsTo("POST", "/api/notepads/np-1/content")
    .map((req) => req.jsonBody);
}

describe("TranscriptClipCapture — selection landing", () => {
  it("lands the selected prose as a blockquote fragment with copy-reference's ref inputs", async () => {
    renderCapture();
    selectAndClip(rangeOverText(screen.getByTestId("prose-0"), 6, 11));

    await waitFor(() => expect(appendBodies()).toHaveLength(1));
    const body = appendBodies()[0] as { operation: string; content: string };
    expect(body.operation).toBe("append");

    const attrs = messageRefAttrsSchema.parse(
      findMessageRefs(body.content)[0]!.attrs,
    );
    expect(attrs["project-name"]).toBe("p1");
    expect(attrs["session-name"]).toBe("s1");
    expect(attrs["conversation-id"]).toBe("c1");
    expect(attrs["conversation-name"]).toBe("Refactor parser");
    expect(attrs["message-index"]).toBe("0");
    expect(attrs.role).toBe("assistant");
    expect(attrs.timestamp).toBe("2026-08-31T10:00:00.000Z");
    expect(attrs.model).toBe("opus");
    expect(attrs.compacted).toBe("false");
    expect(attrs["read-command"]).toBe("cctl conversation read c1 --message 0");

    // The whole fragment is exactly the pinned mapping over that XML (D20).
    expect(body.content).toBe(
      buildClipFragment({
        text: "prose",
        isCode: false,
        provenance: { kind: "ref", xml: findMessageRefs(body.content)[0]!.raw },
      }),
    );

    expect(useToastStoreForTesting.getState().toasts[0]?.message).toBe(
      "Clipped to capture target",
    );
  });

  it("lands a code selection fenced, from the DOM-derived isCode bit", async () => {
    renderCapture();
    const code = screen.getByTestId("code-0").querySelector("code")!;
    selectAndClip(rangeOverText(code, 0, 12));

    await waitFor(() => expect(appendBodies()).toHaveLength(1));
    const body = appendBodies()[0] as { content: string };
    expect(body.content.startsWith("```\nconst answer\n```")).toBe(true);
  });

  it("lands a cross-message selection once with each message reference and one confirmation", async () => {
    renderCapture();
    const range = document.createRange();
    range.setStart(screen.getByTestId("prose-0").firstChild!, 6);
    range.setEnd(screen.getByTestId("prose-1").firstChild!, 5);
    selectAndClip(range);

    await waitFor(() => expect(appendBodies()).toHaveLength(1));
    const body = appendBodies()[0] as { content: string };
    const refs = findMessageRefs(body.content);
    expect(refs.map((ref) => ref.attrs["message-index"])).toEqual(["0", "1"]);
    expect(refs.map((ref) => ref.attrs.role)).toEqual(["assistant", "user"]);
    expect(body.content).toBe(
      [
        buildClipFragment({
          text: "prose worth clipping.\n\nconst answer = 42;",
          isCode: false,
          provenance: { kind: "ref", xml: refs[0]!.raw },
        }),
        buildClipFragment({
          text: "Bravo",
          isCode: false,
          provenance: { kind: "ref", xml: refs[1]!.raw },
        }),
      ].join("\n\n"),
    );
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
  });

  it("ignores selections outside its surface root", () => {
    renderCapture("elsewhere");
    stubSelection(rangeOverText(screen.getByTestId("prose-0"), 0, 5));

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.queryByRole("button", { name: "Clip" })).toBeNull();
  });
});
