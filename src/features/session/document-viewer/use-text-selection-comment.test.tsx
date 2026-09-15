// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { SourceMappedDocumentMarkdown } from "@/components/markdown/Markdown";
import { findCommentBlock, rangeFromBlockOffsets } from "./anchor-dom";
import {
  useTextSelectionComment,
  type SelectionDraft,
} from "./use-text-selection-comment";

//  1: # Title
//  2:
//  3: ## Section Two
//  4:
//  5: Body of section two has a quotable passage inside it.
//  6:
//  7: - alpha beta gamma item
//  8: - second list item here
const DOC = [
  "# Title",
  "",
  "## Section Two",
  "",
  "Body of section two has a quotable passage inside it.",
  "",
  "- alpha beta gamma item",
  "- second list item here",
  "",
].join("\n");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Renders the real (deferred) source-mapped document into a ref'd container and
 * drives the selection hook over it, exposing the latest draft via `onDraft` and
 * the `clear` handle. The container is what a completed selection is validated
 * against, mirroring the annotated surface.
 */
function SelectionHarness({
  onDraft,
  onClear,
}: {
  onDraft: (draft: SelectionDraft | null) => void;
  onClear: (clear: () => void) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { draft, clear } = useTextSelectionComment(ref, DOC);
  onDraft(draft);
  onClear(clear);
  return (
    <div ref={ref}>
      <SourceMappedDocumentMarkdown content={DOC} />
    </div>
  );
}

/**
 * Stub `window.getSelection()` to report the given range as the active selection
 * (or a collapsed selection when null). jsdom's Selection is too partial to drive
 * from real user events, so the hook's completion handler reads this instead.
 */
/** jsdom's Range has no `getBoundingClientRect`; the hook reads it for popover
 *  placement, so give the range a stub rect. */
function withRect(range: Range): Range {
  range.getBoundingClientRect = () =>
    ({ bottom: 0, left: 0, top: 0, right: 0, width: 0, height: 0 }) as DOMRect;
  return range;
}

function stubSelection(range: Range | null): { removeAllRanges: () => void } {
  if (range) withRect(range);
  const removeAllRanges = vi.fn();
  const selection = {
    isCollapsed: range === null,
    rangeCount: range ? 1 : 0,
    getRangeAt: () => range as Range,
    removeAllRanges,
  };
  vi.spyOn(window, "getSelection").mockReturnValue(
    selection as unknown as Selection,
  );
  return { removeAllRanges };
}

async function renderHarness(): Promise<{
  container: HTMLElement;
  draftRef: { current: SelectionDraft | null };
  clearRef: { current: () => void };
}> {
  const draftRef: { current: SelectionDraft | null } = { current: null };
  const clearRef: { current: () => void } = { current: () => {} };
  const { container } = render(
    <SelectionHarness
      onDraft={(d) => (draftRef.current = d)}
      onClear={(c) => (clearRef.current = c)}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector("[data-cc-line='5']")).not.toBeNull(),
  );
  return { container, draftRef, clearRef };
}

function selectQuote(container: HTMLElement): Range {
  const block = findCommentBlock(container, {
    line: 5,
    sectionId: "section-two",
  })!;
  const text = block.textContent ?? "";
  const start = text.indexOf("quotable passage");
  return rangeFromBlockOffsets(
    block,
    start,
    start + "quotable passage".length,
  )!;
}

describe("useTextSelectionComment", () => {
  it("reveals a draft for a pointer-completed selection", async () => {
    const { container, draftRef } = await renderHarness();
    stubSelection(selectQuote(container));

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(draftRef.current?.anchor.quote).toBe("quotable passage");
    expect(draftRef.current?.anchor.line).toBe(5);
  });

  it("reveals a draft for a keyboard-completed selection (keyup, no pointer)", async () => {
    const { container, draftRef } = await renderHarness();
    stubSelection(selectQuote(container));

    // A keyboard selection (Shift+Arrow) finishes on keyup, never firing a
    // pointer event — the affordance must still appear.
    act(() => {
      fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    });

    expect(draftRef.current?.anchor.quote).toBe("quotable passage");
    expect(draftRef.current?.anchor.line).toBe(5);
  });

  it("offers a draft for a selection spanning list items", async () => {
    const { container, draftRef } = await renderHarness();
    const items = container.querySelectorAll("ul li");
    const range = document.createRange();
    range.selectNodeContents(items[0]!);
    range.setEnd(items[1]!, items[1]!.childNodes.length);
    stubSelection(range);

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(draftRef.current?.anchor.quote).toBe(
      "alpha beta gamma item\n\nsecond list item here",
    );
    expect(draftRef.current?.anchor.endBlock).toEqual({
      line: 8,
      sectionId: "section-two",
    });
    expect(draftRef.current?.block).toBe(items[0]);
  });

  it("clears an old draft when a subsequent selection leaves its document", async () => {
    const { container, draftRef } = await renderHarness();
    stubSelection(selectQuote(container));
    fireEvent.pointerUp(document);
    expect(draftRef.current).not.toBeNull();
    const outside = document.createElement("p");
    outside.textContent = "outside";
    document.body.append(outside);
    const range = selectQuote(container);
    range.setEnd(outside.firstChild!, 7);
    stubSelection(range);

    fireEvent.pointerUp(document);

    expect(draftRef.current).toBeNull();
    outside.remove();
  });

  it("clear() collapses the live selection and drops the draft", async () => {
    const { container, draftRef, clearRef } = await renderHarness();
    const { removeAllRanges } = stubSelection(selectQuote(container));

    act(() => {
      fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    });
    expect(draftRef.current).not.toBeNull();

    act(() => {
      clearRef.current();
    });

    expect(draftRef.current).toBeNull();
    expect(removeAllRanges).toHaveBeenCalled();
  });
});
