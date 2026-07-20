// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { quickTicketScreenshotSchema } from "@/lib/tickets/schemas";
import {
  createPageScreenshotCapture,
  normalizeScreenshotCanvas,
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
