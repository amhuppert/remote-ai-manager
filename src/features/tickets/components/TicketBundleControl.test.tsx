// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TicketBundleReview } from "./TicketBundleControl";
import type { BundleTransfer } from "@/lib/tickets/bundle-transfer-schemas";

it("requires an explicit acknowledgment before downloading an incomplete bundle", async () => {
  const user = userEvent.setup();
  let proceeded = false;
  const transfer: BundleTransfer = {
    id: "11111111-1111-4111-8111-111111111111",
    mode: "export",
    status: "ready",
    title: "Portable ticket",
    documentCount: 3,
    omissions: [
      { source: "conversation:missing", reason: "Transcript unavailable" },
    ],
    digest: "a".repeat(64),
    error: null,
    ticketNumber: null,
  };
  render(
    <TicketBundleReview
      transfer={transfer}
      busy={false}
      onProceed={() => {
        proceeded = true;
      }}
    />,
  );
  expect(screen.getByText(/Transcript unavailable/)).toBeVisible();
  const button = screen.getByRole("button", { name: "Download bundle" });
  expect(button).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /acknowledge/i }));
  await user.click(button);
  expect(proceeded).toBe(true);
});
