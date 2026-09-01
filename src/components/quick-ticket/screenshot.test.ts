// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { quickTicketScreenshotSchema } from "@/lib/tickets/schemas";
import {
  createCaptureNodeFilter,
  createPageScreenshotCapture,
  normalizeScreenshotCanvas,
  type CaptureRect,
  type ScreenshotCanvas,
} from "./screenshot";

const WEBP_HEADER = Uint8Array.from([
  82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80,
]);
const PNG_HEADER = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(() => {
  document.body.replaceChildren();
});

function encodedCanvas(options: {
  width?: number;
  height?: number;
  bytes(mediaType: string | undefined, quality: number | undefined): Uint8Array;
  actualType?(requestedType: string | undefined): string;
}): ScreenshotCanvas {
  return {
    width: options.width ?? 1200,
    height: options.height ?? 800,
    toBlob(callback, mediaType, quality) {
      const bytes = options.bytes(mediaType, quality);
      callback(
        new Blob([Uint8Array.from(bytes).buffer], {
          type: options.actualType?.(mediaType) ?? mediaType ?? "image/png",
        }),
      );
    },
  };
}

describe("quick-ticket screenshot capture", () => {
  it("captures only the .app subtree and returns canonical WebP facts", async () => {
    const app = document.createElement("main");
    app.className = "app";
    document.body.append(app);
    const domToCanvas = vi.fn(async () =>
      encodedCanvas({ bytes: () => WEBP_HEADER }),
    );
    const capture = createPageScreenshotCapture({
      loadScreenshotModule: async () => ({ domToCanvas }),
      resizeCanvas: () => {
        throw new Error("unexpected resize");
      },
    });

    const screenshot = await capture();

    expect(domToCanvas).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ scale: 1 }),
    );
    expect(quickTicketScreenshotSchema.parse(screenshot)).toEqual(screenshot);
    expect(screenshot.mediaType).toBe("image/webp");
    expect(screenshot.width).toBe(1200);
    expect(screenshot.height).toBe(800);
  });

  it("downscales oversized output until the decoded payload is at most 2 MB", async () => {
    const resizeCanvas = vi.fn(
      (_source: ScreenshotCanvas, width: number, height: number) =>
        encodedCanvas({
          width,
          height,
          bytes: () => WEBP_HEADER,
        }),
    );
    const first = encodedCanvas({
      width: 2400,
      height: 1600,
      bytes: () => {
        const bytes = new Uint8Array(2 * 1024 * 1024 + 100);
        bytes.set(WEBP_HEADER);
        return bytes;
      },
    });

    const screenshot = await normalizeScreenshotCanvas(first, { resizeCanvas });

    expect(resizeCanvas).toHaveBeenCalledTimes(1);
    expect(screenshot.width).toBeLessThan(2400);
    expect(screenshot.height).toBeLessThan(1600);
    expect(atob(screenshot.base64).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(quickTicketScreenshotSchema.parse(screenshot)).toEqual(screenshot);
  });

  it("downscales compressible output that exceeds pixel or dimension limits", async () => {
    const resizeCanvas = vi.fn(
      (_source: ScreenshotCanvas, width: number, height: number) =>
        encodedCanvas({ width, height, bytes: () => WEBP_HEADER }),
    );
    const first = encodedCanvas({
      width: 9000,
      height: 2000,
      bytes: () => WEBP_HEADER,
    });

    const screenshot = await normalizeScreenshotCanvas(first, { resizeCanvas });

    expect(resizeCanvas).toHaveBeenCalled();
    expect(screenshot.width).toBeLessThanOrEqual(8192);
    expect(screenshot.height).toBeLessThanOrEqual(8192);
    expect(screenshot.width * screenshot.height).toBeLessThanOrEqual(
      16_777_216,
    );
    expect(quickTicketScreenshotSchema.parse(screenshot)).toEqual(screenshot);
  });

  it("uses the PNG fallback when the browser cannot encode WebP", async () => {
    const canvas = encodedCanvas({
      bytes: () => PNG_HEADER,
      actualType: () => "image/png",
    });

    const screenshot = await normalizeScreenshotCanvas(canvas, {
      resizeCanvas: () => {
        throw new Error("unexpected resize");
      },
    });

    expect(screenshot.mediaType).toBe("image/png");
    expect(quickTicketScreenshotSchema.parse(screenshot)).toEqual(screenshot);
  });

  it("fails safely when the page shell is unavailable", async () => {
    await expect(
      createPageScreenshotCapture({
        loadScreenshotModule: async () => ({
          domToCanvas: async () => encodedCanvas({ bytes: () => WEBP_HEADER }),
        }),
        resizeCanvas: () => {
          throw new Error("unexpected resize");
        },
      })(),
    ).rejects.toThrow("page shell");
  });
});

describe("capture node filter", () => {
  const rootRect: CaptureRect = {
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
  };

  function rect(
    top: number,
    bottom: number,
    left = 0,
    right = 1000,
  ): CaptureRect {
    return {
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
    };
  }

  /** Builds a tree under a root and a measure() that reads the supplied boxes. */
  function tree(
    spec: readonly { id: string; parent?: string; box: CaptureRect }[],
    maxElements?: number,
  ) {
    const root = document.createElement("div");
    root.id = "root";
    const boxes = new Map<Element, CaptureRect>([[root, rootRect]]);
    const byId = new Map<string, HTMLElement>([["root", root]]);
    for (const node of spec) {
      const el = document.createElement("div");
      el.id = node.id;
      byId.set(node.id, el);
      boxes.set(el, node.box);
      byId.get(node.parent ?? "root")!.append(el);
    }
    document.body.append(root);
    const filter = createCaptureNodeFilter({
      root,
      rootRect,
      measure: (element) => boxes.get(element) ?? rect(0, 0),
      ...(maxElements === undefined ? {} : { maxElements }),
    });
    return { filter, byId };
  }

  it("prunes elements whose box lies entirely outside the capture root", () => {
    const { filter, byId } = tree([
      { id: "offscreen", box: rect(150_000, 153_000) },
    ]);
    expect(filter(byId.get("offscreen")!)).toBe(false);
  });

  it("keeps elements that intersect the capture root even partially", () => {
    const { filter, byId } = tree([{ id: "straddling", box: rect(-40, 20) }]);
    expect(filter(byId.get("straddling")!)).toBe(true);
  });

  it("keeps zero-area elements, which still lay out visible children", () => {
    const { filter, byId } = tree([{ id: "wrapper", box: rect(500, 500) }]);
    expect(filter(byId.get("wrapper")!)).toBe(true);
  });

  it("keeps non-element nodes, which carry the visible text", () => {
    const { filter } = tree([]);
    expect(filter(document.createTextNode("visible copy"))).toBe(true);
  });

  it("keeps an offscreen element whose descendant reaches into the viewport", () => {
    // The virtualizer's item-list wrapper: absolutely positioned above the
    // viewport with `overflow: visible`, so its own box says "offscreen" while
    // the rows inside it are exactly what the user is looking at. Pruning on
    // the element's own box alone would erase the visible transcript.
    const { filter, byId } = tree([
      { id: "wrapper", box: rect(-5048, -4203) },
      { id: "visibleRow", parent: "wrapper", box: rect(-5048, 1091) },
    ]);

    expect(filter(byId.get("wrapper")!)).toBe(true);
    expect(filter(byId.get("visibleRow")!)).toBe(true);
  });

  it("still prunes an offscreen subtree when nothing inside it is visible", () => {
    const { filter, byId } = tree([
      { id: "wrapper", box: rect(-5048, -4203) },
      { id: "hiddenRow", parent: "wrapper", box: rect(-5048, -4203) },
    ]);

    expect(filter(byId.get("wrapper")!)).toBe(false);
  });

  it("stops retaining elements once the budget is exhausted", () => {
    const { filter, byId } = tree(
      Array.from({ length: 4 }, (_unused, i) => ({
        id: `row${i}`,
        box: rect(0, 10),
      })),
      3,
    );

    expect([0, 1, 2, 3].map((i) => filter(byId.get(`row${i}`)!))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("does not spend budget on pruned elements", () => {
    const { filter, byId } = tree(
      [
        { id: "offscreen", box: rect(150_000, 153_000) },
        { id: "row0", box: rect(0, 10) },
        { id: "row1", box: rect(0, 10) },
      ],
      2,
    );

    expect(filter(byId.get("offscreen")!)).toBe(false);
    expect(filter(byId.get("row0")!)).toBe(true);
    expect(filter(byId.get("row1")!)).toBe(true);
  });
});

describe("capture filter wiring", () => {
  it("hands domToCanvas a filter that prunes the shell's offscreen scrollback", async () => {
    const app = document.createElement("main");
    app.className = "app";
    const offscreen = document.createElement("div");
    const onscreen = document.createElement("div");
    app.append(offscreen, onscreen);
    document.body.append(app);

    const boxes = new Map<Element, CaptureRect>([
      [
        app,
        { top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 },
      ],
      // The transcript keeps its whole scrollback mounted below the fold.
      [
        offscreen,
        {
          top: 150_000,
          left: 0,
          right: 1000,
          bottom: 153_000,
          width: 1000,
          height: 3000,
        },
      ],
      [
        onscreen,
        { top: 10, left: 0, right: 1000, bottom: 60, width: 1000, height: 50 },
      ],
    ]);

    let captured: ((node: Node) => boolean) | undefined;
    const domToCanvas = vi.fn(
      async (
        _element: HTMLElement,
        options: { filter(node: Node): boolean },
      ) => {
        captured = options.filter;
        return encodedCanvas({ bytes: () => WEBP_HEADER });
      },
    );

    await createPageScreenshotCapture({
      loadScreenshotModule: async () => ({ domToCanvas }),
      resizeCanvas: () => {
        throw new Error("unexpected resize");
      },
      measure: (element) =>
        boxes.get(element) ?? {
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
        },
    })();

    expect(captured).toBeDefined();
    expect(captured!(offscreen)).toBe(false);
    expect(captured!(onscreen)).toBe(true);
  });
});
