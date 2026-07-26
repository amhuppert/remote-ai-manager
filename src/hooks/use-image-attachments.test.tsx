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

/**
 * Drives the hook the way the project cockpit does: one hook instance whose
 * scope changes as the user moves between conversation tabs.
 */
function setupScopedHarness(initialScope: string): {
  current: ReturnType<typeof useImageAttachments>;
  setScope: (scope: string) => void;
} {
  const capture: {
    latest: ReturnType<typeof useImageAttachments> | null;
  } = { latest: null };
  function Probe({ scope }: { scope: string }): null {
    const value = useImageAttachments(undefined, scope);
    useEffect(() => {
      capture.latest = value;
    });
    return null;
  }
  const { rerender } = render(<Probe scope={initialScope} />);
  return {
    get current() {
      if (!capture.latest) throw new Error("hook not initialised");
      return capture.latest;
    },
    setScope(scope: string) {
      rerender(<Probe scope={scope} />);
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

describe("useImageAttachments scoping (R3.3)", () => {
  it("keeps each scope's attachments separate and restores them on return", async () => {
    const harness = setupScopedHarness("conversation:c1");

    await act(async () => {
      await harness.current.addImage(makePngFile("for-c1.png"));
    });
    act(() => harness.setScope("conversation:c2"));

    expect(harness.current.pendingImages).toHaveLength(0);

    await act(async () => {
      await harness.current.addImage(makePngFile("for-c2.png"));
    });
    expect(harness.current.pendingImages.map((i) => i.fileName)).toEqual([
      "for-c2.png",
    ]);

    act(() => harness.setScope("conversation:c1"));
    expect(harness.current.pendingImages.map((i) => i.fileName)).toEqual([
      "for-c1.png",
    ]);
  });

  /**
   * Reading a file is asynchronous, so the attachment lands some time after the
   * user chose it. Ownership therefore has to be captured when the user acts,
   * not when the read resolves — otherwise switching tabs mid-read delivers the
   * image to whichever conversation happens to be active by then.
   */
  it("delivers a deferred read to the scope it was started in, not the active one", async () => {
    const harness = setupScopedHarness("conversation:c1");

    let pending: Promise<AddImageResult> | undefined;
    act(() => {
      pending = harness.current.addImage(makePngFile("started-in-c1.png"));
    });
    // Switch before the FileReader resolves.
    act(() => harness.setScope("conversation:c2"));
    await act(async () => {
      await pending;
    });

    expect(harness.current.pendingImages).toHaveLength(0);

    act(() => harness.setScope("conversation:c1"));
    expect(harness.current.pendingImages.map((i) => i.fileName)).toEqual([
      "started-in-c1.png",
    ]);
  });

  it("counts the owning scope's images against the limit, not the active one", async () => {
    const harness = setupScopedHarness("conversation:c1");
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await harness.current.addImage(makePngFile(`c1-${i}.png`));
      });
    }
    expect(harness.current.isAtLimit).toBe(true);

    act(() => harness.setScope("conversation:c2"));

    // A full c1 must not block c2, which has none of its own.
    expect(harness.current.isAtLimit).toBe(false);
    // Collected rather than narrowed, so the assertion needs no non-null
    // assertion to reach the settled result.
    const settled: AddImageResult[] = [];
    await act(async () => {
      settled.push(await harness.current.addImage(makePngFile("c2-first.png")));
    });

    expect(settled.map((result) => result.error)).toEqual([null]);
    expect(harness.current.pendingImages.map((image) => image.fileName)).toEqual(
      ["c2-first.png"],
    );
  });
});
