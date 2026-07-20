// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToastStoreForTesting } from "@/stores/toast.store";

import CopyTicketReferenceButton from "./CopyTicketReferenceButton";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  writeText.mockResolvedValue(undefined);
  useToastStoreForTesting.setState({ toasts: [] });
  Object.assign(navigator, { clipboard: { writeText } });
});

describe("CopyTicketReferenceButton", () => {
  it("places the canonical ticket-ref XML on the clipboard", async () => {
    render(
      <CopyTicketReferenceButton
        projectName="command-center"
        ticketNumber={12}
        title="Add durable ticket context"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /copy ticket reference/i }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
        'identifier="command-center#12" title="Add durable ticket context" ' +
        'read-command="cctl ticket get &apos;command-center#12&apos;" />',
    );
  });

  it("shows a copied confirmation after the clipboard write resolves", async () => {
    render(
      <CopyTicketReferenceButton
        projectName="my-app"
        ticketNumber={3}
        title="T"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /copy ticket reference/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent(/copied/i),
    );
  });

  it("keeps its idle label and reports a clipboard rejection", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    render(
      <CopyTicketReferenceButton
        projectName="my-app"
        ticketNumber={3}
        title="T"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /copy ticket reference/i }),
    );

    await waitFor(() =>
      expect(useToastStoreForTesting.getState().toasts).toEqual([
        expect.objectContaining({
          message: "Couldn't copy reference to my-app#3",
        }),
      ]),
    );
    expect(screen.getByRole("button")).toHaveTextContent("Copy reference");
  });
});
