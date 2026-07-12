// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./SessionRows.stories";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { TicketLinked } = composeStories(stories);

function rowFor(sessionName: string): HTMLElement {
  const nameLink = screen.getByRole("link", { name: sessionName });
  const row = nameLink.closest('[data-testid="session-card"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no session row for ${sessionName}`);
  }
  return row;
}

describe("SessionRows stories", () => {
  it("TicketLinked shows identifier pills for active and historical links only", async () => {
    await TicketLinked.run();

    // Active link: cyan pill after the session name, navigating to the detail
    // route.
    const activePill = await waitFor(() =>
      within(rowFor("implement-auth")).getByRole("link", {
        name: "my-app#12",
      }),
    );
    expect(activePill).toHaveAttribute("href", "/tickets/my-app/12");
    expect(activePill).toHaveAttribute("data-active");

    // Historical link: muted pill, still navigable.
    const endedPill = within(rowFor("refactor-api")).getByRole("link", {
      name: "my-app#7",
    });
    expect(endedPill).toHaveAttribute("href", "/tickets/my-app/7");
    expect(endedPill).not.toHaveAttribute("data-active");

    // Unlinked sessions carry no ticket pill.
    expect(
      within(rowFor("add-dashboard")).queryByRole("link", {
        name: /my-app#/,
      }),
    ).not.toBeInTheDocument();
  });
});
