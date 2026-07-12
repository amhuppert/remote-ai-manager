// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./TicketBoard.stories";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { FiveColumns, EmptyColumns, LongTitles, KeyboardMovement, MoveFails } =
  composeStories(stories);

describe("TicketBoard stories", () => {
  it("FiveColumns renders every status column with its cards", async () => {
    await FiveColumns.run();
    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    for (const label of [
      "Not Started",
      "In Progress",
      "Done",
      "Blocked",
      "Closed",
    ]) {
      expect(
        screen.getByRole("group", { name: `${label} column` }),
      ).toBeInTheDocument();
    }
  });

  it("EmptyColumns shows the drop hint in unpopulated wells", async () => {
    await EmptyColumns.run();
    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/No tickets — drop a card/).length).toBe(4);
  });

  it("LongTitles renders clamped long titles", async () => {
    await LongTitles.run();
    await waitFor(() =>
      expect(screen.getByText(/transcript virtualizer/)).toBeInTheDocument(),
    );
  });

  it("KeyboardMovement focuses the drag handle carrying the keyboard protocol", async () => {
    await KeyboardMovement.run();
    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    // The card root stays non-interactive (links + kebab are its children);
    // the dedicated handle button is the draggable activator.
    const card = document.querySelector(
      "[data-ticket-card='command-center#9']",
    );
    expect(card).not.toHaveAttribute("role");
    const handle = screen.getByRole("button", {
      name: "Drag command-center#9",
    });
    expect(handle).toHaveAttribute("aria-roledescription");
  });

  it("MoveFails renders the board with the failing endpoint wired", async () => {
    await MoveFails.run();
    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
  });
});
