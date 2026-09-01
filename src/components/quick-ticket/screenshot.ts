"use client";

import type { QuickTicketDiagnostics } from "@/lib/tickets/schemas";

export type QuickTicketScreenshot = NonNullable<
  QuickTicketDiagnostics["screenshot"]
>;

export interface ScreenshotCanvas {
  width: number;
  height: number;
  toBlob(
    callback: (blob: Blob | null) => void,
    mediaType?: string,
    quality?: number,
  ): void;
}

interface ScreenshotModule {
  domToCanvas(
    element: HTMLElement,
    options: { scale: number; filter(node: Node): boolean },
  ): Promise<ScreenshotCanvas>;
}

interface NormalizeScreenshotDeps {
  resizeCanvas(
    source: ScreenshotCanvas,
    width: number,
    height: number,
  ): ScreenshotCanvas;
}

interface PageScreenshotDeps extends NormalizeScreenshotDeps {
  loadScreenshotModule(): Promise<ScreenshotModule>;
  /** Layout probe for the capture filter; injected so the wiring is testable. */
  measure?(element: Element): CaptureRect;
}

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 16_777_216;
const MAX_SCREENSHOT_DIMENSION = 8192;
const WEBP_QUALITY = 0.82;

/**
 * Ceiling on elements cloned into the capture. The viewport filter already
 * prunes the transcript's offscreen bulk; this is the backstop for a page whose
 * *visible* region is pathologically dense, so a capture degrades to a partial
 * image instead of pinning the main thread.
 */
const MAX_CAPTURED_ELEMENTS = 5000;

/** The structural subset of `DOMRect` the capture filter reads. */
export interface CaptureRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface CaptureNodeFilterDeps {
  /** Subtree the capture walks; bounds are precomputed across it once. */
  root: Element;
  /** Layout box of the capture root; anything disjoint from it cannot appear. */
  rootRect: CaptureRect;
  measure(element: Element): CaptureRect;
  maxElements?: number;
}

/**
 * Union of each element's own box with every box beneath it, in one bottom-up
 * pass.
 *
 * An element's own box is not a safe proxy for where its subtree paints:
 * `react-virtuoso`'s item-list wrapper is absolutely positioned above the
 * viewport with `overflow: visible`, so its box reads as offscreen while the
 * rows inside it are precisely what is on screen. Pruning on the element's own
 * box would erase the visible transcript from the capture.
 */
function computeSubtreeBounds(
  root: Element,
  measure: (element: Element) => CaptureRect,
): Map<Element, CaptureRect> {
  const bounds = new Map<Element, CaptureRect>();
  const all = root.querySelectorAll("*");
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const element = all[i]!;
    const own = measure(element);
    const seen = bounds.get(element);
    // A zero-area element contributes nothing of its own; only its subtree
    // (already folded in on an earlier iteration) decides where it paints.
    const self =
      own.width === 0 && own.height === 0 ? (seen ?? own) : union(seen, own);
    bounds.set(element, self);
    const parent = element.parentElement;
    if (parent !== null && parent !== root.parentElement) {
      bounds.set(parent, union(bounds.get(parent), self));
    }
  }
  return bounds;
}

function union(a: CaptureRect | undefined, b: CaptureRect): CaptureRect {
  if (a === undefined) return b;
  const top = Math.min(a.top, b.top);
  const left = Math.min(a.left, b.left);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return {
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Decides which nodes `domToCanvas` clones.
 *
 * The screenshot serializer copies every computed style property onto a clone
 * of each node it walks — ~1.6ms per element. The transcript keeps its whole
 * scrollback mounted, so an unfiltered capture of `.app` walks tens of
 * thousands of elements and blocks the main thread for tens of seconds
 * (command-center#97). Everything scrolled out of the root's box is clipped
 * out of the rasterized image anyway, so pruning it costs no fidelity.
 *
 * Returning false skips the node *and its subtree*, which is what makes the
 * pruning cheap.
 */
export function createCaptureNodeFilter(
  deps: CaptureNodeFilterDeps,
): (node: Node) => boolean {
  const maxElements = deps.maxElements ?? MAX_CAPTURED_ELEMENTS;
  const { rootRect } = deps;
  const bounds = computeSubtreeBounds(deps.root, deps.measure);
  let kept = 0;
  return (node: Node) => {
    if (!(node instanceof Element)) return true;
    const box = bounds.get(node);
    // No recorded bounds means a zero-area element with an empty subtree: it
    // paints nothing itself, so keeping it is both cheap and safe.
    if (box !== undefined && box.width !== 0 && box.height !== 0) {
      const disjoint =
        box.bottom <= rootRect.top ||
        box.top >= rootRect.bottom ||
        box.right <= rootRect.left ||
        box.left >= rootRect.right;
      if (disjoint) return false;
    }
    // Budget is spent only on elements that survive the geometry test, so a
    // long offscreen tail can never starve the visible region.
    if (kept >= maxElements) return false;
    kept += 1;
    return true;
  };
}

function canvasToBlob(
  canvas: ScreenshotCanvas,
  mediaType: "image/webp" | "image/png",
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error("The page screenshot could not be encoded."));
          return;
        }
        resolve(blob);
      },
      mediaType,
      mediaType === "image/webp" ? WEBP_QUALITY : undefined,
    );
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(index, index + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
}

async function encodeCanvas(canvas: ScreenshotCanvas): Promise<{
  blob: Blob;
  mediaType: "image/webp" | "image/png";
}> {
  const requestedWebp = await canvasToBlob(canvas, "image/webp");
  if (requestedWebp.type === "image/webp") {
    return { blob: requestedWebp, mediaType: "image/webp" };
  }
  const png =
    requestedWebp.type === "image/png"
      ? requestedWebp
      : await canvasToBlob(canvas, "image/png");
  return { blob: png, mediaType: "image/png" };
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("The page screenshot could not be read."));
        return;
      }
      resolve(new Uint8Array(reader.result));
    });
    reader.addEventListener("error", () => {
      reject(
        reader.error ?? new Error("The page screenshot could not be read."),
      );
    });
    reader.readAsArrayBuffer(blob);
  });
}

function defaultResizeCanvas(
  source: ScreenshotCanvas,
  width: number,
  height: number,
): ScreenshotCanvas {
  const target = document.createElement("canvas");
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (context === null) {
    throw new Error("The page screenshot could not be resized.");
  }
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return target;
}

export async function normalizeScreenshotCanvas(
  initialCanvas: ScreenshotCanvas,
  deps: NormalizeScreenshotDeps = { resizeCanvas: defaultResizeCanvas },
): Promise<QuickTicketScreenshot> {
  let canvas = initialCanvas;
  let encoded = await encodeCanvas(canvas);

  for (
    let attempt = 0;
    encoded.blob.size > MAX_SCREENSHOT_BYTES ||
    canvas.width * canvas.height > MAX_SCREENSHOT_PIXELS ||
    canvas.width > MAX_SCREENSHOT_DIMENSION ||
    canvas.height > MAX_SCREENSHOT_DIMENSION;
    attempt += 1
  ) {
    if (attempt >= 7) {
      throw new Error("The page screenshot exceeds the 2 MB limit.");
    }
    const byteScale =
      encoded.blob.size > MAX_SCREENSHOT_BYTES
        ? Math.sqrt(MAX_SCREENSHOT_BYTES / encoded.blob.size) * 0.9
        : 1;
    const pixelScale = Math.sqrt(
      MAX_SCREENSHOT_PIXELS / (canvas.width * canvas.height),
    );
    const dimensionScale = Math.min(
      MAX_SCREENSHOT_DIMENSION / canvas.width,
      MAX_SCREENSHOT_DIMENSION / canvas.height,
    );
    const scale = Math.min(0.9, byteScale, pixelScale, dimensionScale);
    const width = Math.max(1, Math.floor(canvas.width * scale));
    const height = Math.max(1, Math.floor(canvas.height * scale));
    canvas = deps.resizeCanvas(canvas, width, height);
    encoded = await encodeCanvas(canvas);
  }

  const bytes = await blobToBytes(encoded.blob);
  return {
    mediaType: encoded.mediaType,
    base64: bytesToBase64(bytes),
    width: canvas.width,
    height: canvas.height,
  };
}

export function createPageScreenshotCapture(
  deps: PageScreenshotDeps = {
    loadScreenshotModule: () => import("modern-screenshot"),
    resizeCanvas: defaultResizeCanvas,
  },
): () => Promise<QuickTicketScreenshot> {
  return async () => {
    const pageShell = document.querySelector<HTMLElement>(".app");
    if (pageShell === null) {
      throw new Error("The page shell is unavailable for screenshot capture.");
    }
    const screenshotModule = await deps.loadScreenshotModule();
    const measure =
      deps.measure ?? ((element: Element) => element.getBoundingClientRect());
    const canvas = await screenshotModule.domToCanvas(pageShell, {
      scale: 1,
      filter: createCaptureNodeFilter({
        root: pageShell,
        rootRect: measure(pageShell),
        measure,
      }),
    });
    return normalizeScreenshotCanvas(canvas, deps);
  };
}

export const captureQuickTicketScreenshot = createPageScreenshotCapture();
