// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToastStoreForTesting } from "@/stores/toast.store";
import { copyTicketReference } from "./copy-ticket-reference";

const ITEM = {
  projectName: "command-center",
  number: 12,
  title: "Add durable ticket context",
};

describe("copyTicketReference", () => {
  beforeEach(() => {
    useToastStoreForTesting.setState({ toasts: [] });
  });

  it("reports clipboard rejection without rejecting its returned promise", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyTicketReference(ITEM)).resolves.toBe(false);

    expect(useToastStoreForTesting.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Couldn't copy reference to command-center#12",
      }),
    ]);
  });

  it("returns success and keeps the existing success notice", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyTicketReference(ITEM)).resolves.toBe(true);

    expect(useToastStoreForTesting.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Copied reference to command-center#12",
      }),
    ]);
  });
});
