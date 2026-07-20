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
    options: { scale: number },
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
}

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 16_777_216;
const MAX_SCREENSHOT_DIMENSION = 8192;
const WEBP_QUALITY = 0.82;

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
    const canvas = await screenshotModule.domToCanvas(pageShell, { scale: 1 });
    return normalizeScreenshotCanvas(canvas, deps);
  };
}

export const captureQuickTicketScreenshot = createPageScreenshotCapture();
