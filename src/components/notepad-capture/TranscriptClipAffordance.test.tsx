// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TranscriptClipAffordance } from "./TranscriptClipAffordance";
import type { TranscriptClipDraft } from "./use-transcript-clip-selection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A transcript-shaped DOM carrying the clip-source contract MessageRow stamps:
 * `data-clip-*` on the content element of rows that offer copy-reference, and
 * nothing on rows that do not (queued/provisional rows, chrome).
 */
function TranscriptFixture(): React.JSX.Element {
  return (
    <div className="conversation">
      <div className="message">
        <div
          className="message-content"
          data-clip-index="0"
          data-clip-role="assistant"
          data-clip-timestamp="2026-08-31T10:00:00.000Z"
          data-clip-model="opus"
        >
          <p data-testid="prose-0">Alpha prose worth clipping.</p>
          {"\n"}
          <p data-testid="paragraph-0">Second paragraph.</p>
          {"\n"}
          <pre data-testid="code-0">
            <code>const answer = 42;</code>
          </pre>
          {"\n"}
          <button type="button" data-testid="code-copy">
            Copy code
          </button>
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
      </div>
      <div className="message">
        <div className="message-content">
          <p data-testid="ungated">Queued row content, never clippable.</p>
        </div>
      </div>
      <p data-testid="outside">Chrome outside any message.</p>
    </div>
  );
}

function renderHarness(): { onClip: ReturnType<typeof vi.fn> } {
  const onClip = vi.fn<(draft: TranscriptClipDraft) => void>();
  render(
    <>
      <TranscriptClipAffordance onClip={onClip} />
      <TranscriptFixture />
    </>,
  );
  return { onClip };
}

/** jsdom's Range lacks the rect APIs the trigger placement reads. */
function withRect(range: Range, overrides: Partial<DOMRect> = {}): Range {
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
      ...overrides,
    }) as DOMRect;
  return range;
}

/**
 * Stub `window.getSelection()` to report the given range (or a collapsed
 * selection when null) — jsdom's Selection is too partial to drive from real
 * user events, so the hook's completion handler reads this instead.
 */
function stubSelection(
  range: Range | null,
  rect?: Partial<DOMRect>,
): { removeAllRanges: () => void } {
  if (range) withRect(range, rect);
  const removeAllRanges = vi.fn();
  const selection = {
    isCollapsed: range === null,
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range as Range,
    removeAllRanges,
    toString: () => (range ? range.toString() : ""),
  };
  vi.spyOn(window, "getSelection").mockReturnValue(
    selection as unknown as Selection,
  );
  return { removeAllRanges };
}

/** A range over `[start, end)` of the element's single text node. */
function rangeOverText(element: Element, start: number, end: number): Range {
  const textNode = element.childNodes[0];
  if (!textNode) throw new Error("fixture element has no text node");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  return range;
}

function clipTrigger(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Clip" });
}

describe("TranscriptClipAffordance — single-message mapping", () => {
  it("offers the trigger for a pointer selection inside one gated message and clips it", () => {
    const { onClip } = renderHarness();
    const { removeAllRanges } = stubSelection(
      rangeOverText(screen.getByTestId("prose-0"), 6, 11),
    );

    act(() => {
      fireEvent.pointerUp(document);
    });

    const trigger = clipTrigger();
    expect(trigger).not.toBeNull();
    // Portaled to document.body so the docked stage's transform cannot
    // displace it.
    expect(trigger?.closest("[data-clip-affordance]")?.parentElement).toBe(
      document.body,
    );

    fireEvent.click(trigger!);
    expect(onClip).toHaveBeenCalledWith({
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          timestamp: "2026-08-31T10:00:00.000Z",
          model: "opus",
          text: "prose",
          isCode: false,
        },
      ],
      rect: expect.objectContaining({ bottom: 120 }) as DOMRect,
    });
    // Clipping consumes the selection: the trigger dismisses.
    expect(clipTrigger()).toBeNull();
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it("offers the trigger for a keyboard-completed selection (keyup, no pointer event)", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("prose-1"), 0, 5));

    act(() => {
      fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    });

    expect(clipTrigger()).not.toBeNull();
  });

  it("carries missing timestamp and model through as null", () => {
    const { onClip } = renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("prose-1"), 0, 5));

    act(() => {
      fireEvent.pointerUp(document);
    });
    fireEvent.click(clipTrigger()!);

    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            messageIndex: 1,
            role: "user",
            timestamp: null,
            model: null,
          }),
        ],
      }),
    );
  });

  it("clips a selection spanning messages with ordered attribution and no chrome", () => {
    const { onClip } = renderHarness();
    const range = document.createRange();
    range.setStart(screen.getByTestId("prose-0").childNodes[0]!, 0);
    range.setEnd(screen.getByTestId("prose-1").childNodes[0]!, 5);
    stubSelection(range);

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(clipTrigger()).not.toBeNull();
    fireEvent.click(clipTrigger()!);
    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            messageIndex: 0,
            text: "Alpha prose worth clipping.\n\nSecond paragraph.\n\nconst answer = 42;",
            isCode: false,
          }),
          expect.objectContaining({
            messageIndex: 1,
            text: "Bravo",
            isCode: false,
          }),
        ],
      }),
    );
  });

  it("preserves paragraph boundaries within a message", () => {
    const { onClip } = renderHarness();
    const range = document.createRange();
    range.setStart(screen.getByTestId("prose-0").firstChild!, 6);
    range.setEnd(screen.getByTestId("paragraph-0").firstChild!, 6);
    stubSelection(range);
    fireEvent.pointerUp(document);
    fireEvent.click(clipTrigger()!);
    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            text: "prose worth clipping.\n\nSecond",
            isCode: false,
          }),
        ],
      }),
    );
  });

  it("combines split rows for one message into one attributed selection", () => {
    const { onClip } = renderHarness();
    const content = screen.getByTestId("prose-1").parentElement!;
    content.dataset["clipIndex"] = "0";
    content.dataset["clipRole"] = "assistant";
    const range = document.createRange();
    range.setStart(screen.getByTestId("paragraph-0").firstChild!, 0);
    range.setEnd(screen.getByTestId("prose-1").firstChild!, 5);
    stubSelection(range);
    fireEvent.pointerUp(document);
    fireEvent.click(clipTrigger()!);
    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            messageIndex: 0,
            text: "Second paragraph.\n\nconst answer = 42;\n\nBravo",
          }),
        ],
      }),
    );
  });

  it("does not offer clips on controls inside a message", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("code-copy"), 0, 4));
    fireEvent.pointerUp(document);
    expect(clipTrigger()).toBeNull();
  });

  it("refuses a range crossing an ungated row even when both endpoints are gated", () => {
    renderHarness();
    const first = screen.getByTestId("prose-0").closest(".message")!;
    const ungated = screen.getByTestId("ungated").closest(".message")!;
    first.after(ungated);
    const range = document.createRange();
    range.setStart(screen.getByTestId("prose-0").firstChild!, 0);
    range.setEnd(screen.getByTestId("prose-1").firstChild!, 5);
    stubSelection(range);
    fireEvent.pointerUp(document);
    expect(clipTrigger()).toBeNull();
  });

  it("refuses a range between transcript roots", () => {
    renderHarness();
    const other = document.createElement("div");
    other.className = "conversation";
    const last = screen.getByTestId("prose-1").closest(".message")!;
    last.parentElement!.after(other);
    other.append(last);
    const range = document.createRange();
    range.setStart(screen.getByTestId("prose-0").firstChild!, 0);
    range.setEnd(screen.getByTestId("prose-1").firstChild!, 5);
    stubSelection(range);
    fireEvent.pointerUp(document);
    expect(clipTrigger()).toBeNull();
    other.remove();
  });

  it("offers nothing on a row without the clip-source contract (queued/provisional)", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("ungated"), 0, 6));

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(clipTrigger()).toBeNull();
  });

  it("offers nothing for a selection outside message content", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("outside"), 0, 6));

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(clipTrigger()).toBeNull();
  });
});

describe("TranscriptClipAffordance — code derivation (D20)", () => {
  it("preserves selected code indentation and blank lines", () => {
    const { onClip } = renderHarness();
    const code = screen.getByTestId("code-0").querySelector("code")!;
    code.textContent = " \n  ";
    stubSelection(rangeOverText(code, 0, 4));
    fireEvent.pointerUp(document);
    fireEvent.click(clipTrigger()!);
    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ text: " \n  ", isCode: true })],
      }),
    );
  });

  it("keeps a code-only excerpt fenced when the selection continues into another message", () => {
    const { onClip } = renderHarness();
    const range = document.createRange();
    range.setStart(
      screen.getByTestId("code-0").querySelector("code")!.firstChild!,
      0,
    );
    range.setEnd(screen.getByTestId("prose-1").firstChild!, 5);
    stubSelection(range);
    fireEvent.pointerUp(document);
    fireEvent.click(clipTrigger()!);
    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ text: "const answer = 42;", isCode: true }),
          expect.objectContaining({ text: "Bravo", isCode: false }),
        ],
      }),
    );
  });

  it("marks a selection inside a fenced block as code", () => {
    const { onClip } = renderHarness();
    const code = screen.getByTestId("code-0").querySelector("code")!;
    stubSelection(rangeOverText(code, 0, 12));

    act(() => {
      fireEvent.pointerUp(document);
    });
    fireEvent.click(clipTrigger()!);

    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ text: "const answer", isCode: true }),
        ],
      }),
    );
  });

  it("marks a prose selection as non-code", () => {
    const { onClip } = renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("prose-1"), 0, 5));

    act(() => {
      fireEvent.pointerUp(document);
    });
    fireEvent.click(clipTrigger()!);

    expect(onClip).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ isCode: false })],
      }),
    );
  });
});

describe("TranscriptClipAffordance — placement", () => {
  it("repositions the trigger when the same text is selected at a different spot", () => {
    renderHarness();
    const prose = screen.getByTestId("prose-0");
    // "Alpha prose worth clipping." carries "r" twice; selecting the second
    // occurrence yields a draft identical in message, text, and code bit —
    // only the rect distinguishes it, and the trigger must follow it.
    stubSelection(rangeOverText(prose, 7, 8));
    act(() => {
      fireEvent.pointerUp(document);
    });
    const first = clipTrigger()!.closest<HTMLElement>(
      "[data-clip-affordance]",
    )!;
    expect(first.style.left).toBe("140px");

    stubSelection(rangeOverText(prose, 14, 15), {
      left: 400,
      right: 460,
      width: 60,
      x: 400,
    });
    act(() => {
      fireEvent.pointerUp(document);
    });

    const second = clipTrigger()!.closest<HTMLElement>(
      "[data-clip-affordance]",
    )!;
    expect(second.style.left).toBe("430px");
  });
});

describe("TranscriptClipAffordance — dismissal", () => {
  it("dismisses when the selection collapses", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("prose-0"), 0, 5));
    act(() => {
      fireEvent.pointerUp(document);
    });
    expect(clipTrigger()).not.toBeNull();

    stubSelection(null);
    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(clipTrigger()).toBeNull();
  });

  it("keeps the draft when the pointer lands on the affordance itself", () => {
    renderHarness();
    stubSelection(rangeOverText(screen.getByTestId("prose-0"), 0, 5));
    act(() => {
      fireEvent.pointerUp(document);
    });
    const trigger = clipTrigger()!;

    // Interacting with the trigger collapses the selection in some browsers;
    // the completion listener must not treat that as a dismissal.
    stubSelection(null);
    act(() => {
      fireEvent.pointerUp(trigger);
    });

    expect(clipTrigger()).not.toBeNull();
  });
});
