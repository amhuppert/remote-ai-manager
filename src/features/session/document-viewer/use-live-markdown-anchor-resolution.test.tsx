// @vitest-environment jsdom
import { useRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MarkdownAnnotationSource } from "@/components/document-viewer/annotation-contract";

import {
  resolveLiveMarkdownAnchors,
  useLiveMarkdownAnchorResolution,
} from "./use-live-markdown-anchor-resolution";

interface NativeShapedSource extends MarkdownAnnotationSource {
  nativeThreadId: string;
}

function source(
  id: string,
  overrides: Partial<NativeShapedSource["anchor"]> = {},
): NativeShapedSource {
  return {
    id,
    nativeThreadId: `native-${id}`,
    tone: "active",
    accessibleLabel: `Review thread ${id}`,
    anchor: {
      sectionId: "requirements",
      headingLabel: "Requirements",
      line: 4,
      charStart: 7,
      charEnd: 13,
      quote: "target",
      prefix: "prefix ",
      suffix: " suffix",
      docRevision: "revision-1",
      ...overrides,
    },
  };
}

const DEFERRED_SOURCES = [source("deferred")];

function stampedBlock(text = "prefix target suffix"): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = `<p data-cc-line="4" data-cc-section="requirements">${text}</p>`;
  return container;
}

describe("resolveLiveMarkdownAnchors", () => {
  it("resolves one passage across blocks and paints each selected text segment", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="4" data-cc-section="requirements">prefix target</p><p data-cc-line="6" data-cc-section="requirements">middle</p><p data-cc-line="8" data-cc-section="requirements">last suffix</p>';
    const passage = source("passage", {
      endBlock: { line: 8, sectionId: "requirements" },
      charEnd: 27,
      quote: "target\n\nmiddle\n\nlast",
    });

    const [resolved] = resolveLiveMarkdownAnchors([passage], container);

    expect(resolved?.anchorState).toEqual({
      status: "anchored",
      charStart: 7,
      charEnd: 27,
    });
    expect(resolved?.ranges?.map((range) => range.toString())).toEqual([
      "target",
      "middle",
      "last",
    ]);
    expect(resolved?.block).toBe(container.querySelector("p"));

    container.querySelectorAll("p")[1]!.textContent = "changed";
    expect(
      resolveLiveMarkdownAnchors([passage], container)[0]?.anchorState.status,
    ).toBe("stale");
  });

  it("reanchors the entire multi-block quote after an edit before its start", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="4" data-cc-section="requirements">a prefix target</p><p data-cc-line="6" data-cc-section="requirements">last</p>';
    const [resolved] = resolveLiveMarkdownAnchors(
      [
        source("shifted-passage", {
          endBlock: { line: 6, sectionId: "requirements" },
          charEnd: 19,
          quote: "target\n\nlast",
        }),
      ],
      container,
    );

    expect(resolved?.anchorState).toEqual({
      status: "reanchored",
      charStart: 9,
      charEnd: 21,
    });
    expect(resolved?.ranges?.map((range) => range.toString())).toEqual([
      "target",
      "last",
    ]);
  });

  it("distinguishes exact stored offsets from a unique nearby shift", () => {
    const container = stampedBlock();

    const [exact, shifted] = resolveLiveMarkdownAnchors(
      [source("exact"), source("shifted", { charStart: 0, charEnd: 6 })],
      container,
    );

    expect(exact?.anchorState).toEqual({
      status: "anchored",
      charStart: 7,
      charEnd: 13,
    });
    expect(shifted?.anchorState).toEqual({
      status: "reanchored",
      charStart: 7,
      charEnd: 13,
    });
    expect(exact?.block).toBe(container.querySelector("p"));
    expect(shifted?.block).toBe(exact?.block);
  });

  it("marks removed and ambiguous quotes stale without choosing a block", () => {
    const removed = resolveLiveMarkdownAnchors(
      [source("removed", { quote: "missing", charEnd: 14 })],
      stampedBlock(),
    );
    const ambiguousContainer = document.createElement("div");
    ambiguousContainer.innerHTML = `
      <div data-cc-line="4" data-cc-section="requirements">
        <p data-cc-line="4" data-cc-section="requirements">prefix target suffix</p>
        <p data-cc-line="4" data-cc-section="requirements">prefix target suffix</p>
      </div>
    `;
    const ambiguous = resolveLiveMarkdownAnchors(
      [source("ambiguous")],
      ambiguousContainer,
    );

    expect(removed[0]).toMatchObject({
      anchorState: { status: "stale" },
      block: null,
    });
    expect(ambiguous[0]).toMatchObject({
      anchorState: { status: "stale" },
      block: null,
    });
  });

  it("preserves one output and Native-specific fields for every input", () => {
    const resolved = resolveLiveMarkdownAnchors(
      [source("one"), source("two", { line: 99 })],
      stampedBlock(),
    );

    expect(resolved.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(resolved.map(({ nativeThreadId }) => nativeThreadId)).toEqual([
      "native-one",
      "native-two",
    ]);
  });
});

function DeferredHarness({
  rendered,
  onResolved,
}: {
  rendered: boolean;
  onResolved(
    value: readonly ReturnType<typeof resolveLiveMarkdownAnchors>[number][],
  ): void;
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const resolved = useLiveMarkdownAnchorResolution(
    DEFERRED_SOURCES,
    "prefix target suffix",
    contentRef,
  );
  onResolved(resolved);
  return (
    <div ref={contentRef}>
      {rendered ? (
        <p data-cc-line="4" data-cc-section="requirements">
          prefix target suffix
        </p>
      ) : null}
    </div>
  );
}

describe("useLiveMarkdownAnchorResolution", () => {
  it("invalidates a passage when the live text node changes in place", async () => {
    let latest: readonly ReturnType<
      typeof resolveLiveMarkdownAnchors
    >[number][] = [];
    const view = render(
      <DeferredHarness rendered onResolved={(value) => (latest = value)} />,
    );
    await waitFor(() => expect(latest[0]?.anchorState.status).toBe("anchored"));

    act(() => {
      const text = view.container.querySelector("p")!.firstChild!;
      text.nodeValue = "prefix removed suffix";
    });

    await waitFor(() => expect(latest[0]?.anchorState.status).toBe("stale"));
  });

  it("resolves a deferred block after the always-mounted subtree mutates", async () => {
    let latest: readonly ReturnType<
      typeof resolveLiveMarkdownAnchors
    >[number][] = [];
    const view = render(
      <DeferredHarness
        rendered={false}
        onResolved={(value) => (latest = value)}
      />,
    );

    expect(latest[0]?.anchorState.status).toBe("stale");
    view.rerender(
      <DeferredHarness rendered onResolved={(value) => (latest = value)} />,
    );

    await waitFor(() => expect(latest[0]?.anchorState.status).toBe("anchored"));
    expect(latest[0]?.block).toBe(view.container.querySelector("p"));
  });
});
