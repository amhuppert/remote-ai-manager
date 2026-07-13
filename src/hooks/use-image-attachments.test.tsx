// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render, act } from "@testing-library/react";
import {
  useImageAttachments,
  type AddImageResult,
} from "./use-image-attachments";

beforeEach(() => {
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:stub"),
      configurable: true,
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
    });
  }
});

function makePngFile(name = "x.png", bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function setupHookHarness(): {
  current: ReturnType<typeof useImageAttachments>;
} {
  const capture: {
    latest: ReturnType<typeof useImageAttachments> | null;
  } = { latest: null };
  function Probe(): null {
    const value = useImageAttachments();
    useEffect(() => {
      capture.latest = value;
    });
    return null;
  }
  render(<Probe />);
  return {
    get current() {
      if (!capture.latest) throw new Error("hook not initialised");
      return capture.latest;
    },
  };
}

describe("useImageAttachments", () => {
  it("addImage returns the new attachment on success and updates pendingImages", async () => {
    const harness = setupHookHarness();
    let res: AddImageResult | undefined;
    await act(async () => {
      res = await harness.current.addImage(makePngFile());
    });
    expect(res).toBeDefined();
    expect(res!.error).toBeNull();
    expect(res!.attachment).not.toBeNull();
    expect(res!.attachment!.fileName).toBe("x.png");
    expect(res!.attachment!.mediaType).toBe("image/png");
    expect(harness.current.pendingImages).toHaveLength(1);
    expect(harness.current.pendingImages[0]!.id).toBe(res!.attachment!.id);
  });

  it("assigns a new attachment id after restored images", async () => {
    const capture: {
      latest: ReturnType<typeof useImageAttachments> | null;
    } = { latest: null };
    function Probe(): null {
      const value = useImageAttachments([
        {
          attachmentId: "img-1",
          mediaType: "image/png",
          base64Data: "cmVzdG9yZWQ=",
        },
      ]);
      useEffect(() => {
        capture.latest = value;
      });
      return null;
    }
    render(<Probe />);

    await act(async () => {
      await capture.latest!.addImage(makePngFile("new.png"));
    });

    expect(capture.latest!.pendingImages.map((image) => image.id)).toEqual([
      "img-1",
      "img-2",
    ]);
  });

  it("addImage returns an error and a null attachment for unsupported mime types", async () => {
    const harness = setupHookHarness();
    const bad = new File(["nope"], "x.txt", { type: "text/plain" });
    let res: AddImageResult | undefined;
    await act(async () => {
      res = await harness.current.addImage(bad);
    });
    expect(res!.attachment).toBeNull();
    expect(res!.error).toMatch(/JPEG|PNG|GIF|WebP/);
    expect(harness.current.pendingImages).toHaveLength(0);
  });

  it("addImage returns an error when over the 5-image limit", async () => {
    const harness = setupHookHarness();
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await harness.current.addImage(makePngFile(`x${i}.png`));
      });
    }
    expect(harness.current.pendingImages).toHaveLength(5);
    expect(harness.current.isAtLimit).toBe(true);
    let res: AddImageResult | undefined;
    await act(async () => {
      res = await harness.current.addImage(makePngFile("over.png"));
    });
    expect(res!.attachment).toBeNull();
    expect(res!.error).toMatch(/Maximum/);
  });

  it("serializes concurrent additions in caller order and reserves the image limit", async () => {
    const harness = setupHookHarness();
    const files = Array.from({ length: 7 }, (_, index) =>
      makePngFile(`image-${index + 1}.png`),
    );
    let results: AddImageResult[] = [];

    await act(async () => {
      results = await Promise.all(
        files.map((file) => harness.current.addImage(file)),
      );
    });

    expect(
      harness.current.pendingImages.map((image) => image.fileName),
    ).toEqual(files.slice(0, 5).map((file) => file.name));
    expect(results.filter((result) => result.attachment)).toHaveLength(5);
    expect(
      results.slice(5).every((result) => result.error?.includes("Maximum")),
    ).toBe(true);
  });
});
