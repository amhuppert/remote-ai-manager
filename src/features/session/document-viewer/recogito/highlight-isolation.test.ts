// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTextAnnotator,
  rangeToSelector,
  type TextAnnotation,
  type TextAnnotator,
} from "@recogito/text-annotator";

const registry = new Map<string, Set<Range>>();
const annotators: TextAnnotator<TextAnnotation>[] = [];
const originalHighlights = Object.getOwnPropertyDescriptor(CSS, "highlights");
const originalClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);

beforeEach(() => {
  vi.useFakeTimers();
  registry.clear();
  Object.defineProperty(CSS, "highlights", {
    configurable: true,
    value: registry,
  });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const rect = new DOMRect(20, 20, 100, 20);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([rect], { item: () => rect }),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 200),
  );
});

afterEach(() => {
  for (const annotator of annotators.splice(0)) annotator.destroy();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClientRects)
    Object.defineProperty(
      Range.prototype,
      "getClientRects",
      originalClientRects,
    );
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (originalHighlights)
    Object.defineProperty(CSS, "highlights", originalHighlights);
  else Reflect.deleteProperty(CSS, "highlights");
});

function createHost(
  text: string,
  annotationId?: string,
): TextAnnotator<TextAnnotation> {
  const container = document.createElement("div");
  container.textContent = text;
  document.body.append(container);
  const annotator = createTextAnnotator<TextAnnotation, TextAnnotation>(
    container,
    {
      renderer: "CSS_HIGHLIGHTS",
      annotatingEnabled: false,
    },
  );
  annotators.push(annotator);
  if (annotationId) {
    const range = document.createRange();
    range.selectNodeContents(container);
    annotator.setAnnotations([
      {
        id: annotationId,
        bodies: [],
        target: {
          annotation: annotationId,
          selector: [rangeToSelector(range, container)],
        },
      },
    ]);
  }
  return annotator;
}

function highlightedPassages(): string[] {
  return [...registry.values()]
    .map((ranges) => [...ranges].map((range) => range.toString()).join(""))
    .sort();
}

describe("Recogito CSS highlight isolation", () => {
  it("keeps an annotated host painted when an empty host redraws after resize", async () => {
    createHost("commented passage", "comment-1");
    await vi.advanceTimersByTimeAsync(300);
    expect(highlightedPassages()).toEqual(["commented passage"]);
    createHost("empty section");
    await vi.advanceTimersByTimeAsync(300);

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(300);

    expect(highlightedPassages()).toEqual(["commented passage"]);
  });

  it("keeps each host's ranges when the same annotation is open twice and one host closes", async () => {
    const first = createHost("first view", "shared-comment");
    const second = createHost("second view", "shared-comment");
    await vi.advanceTimersByTimeAsync(300);
    expect(highlightedPassages()).toEqual(["first view", "second view"]);

    second.renderer.redraw(true);
    second.destroy();
    annotators.splice(annotators.indexOf(second), 1);

    expect(highlightedPassages()).toEqual(["first view"]);
    first.renderer.redraw(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(highlightedPassages()).toEqual(["first view"]);
  });
});
