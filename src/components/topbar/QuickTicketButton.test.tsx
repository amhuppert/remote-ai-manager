// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { HOTKEY_REGISTRY, formatHotkeyDisplay } from "@/lib/shared/hotkeys";
import {
  useQuickTicketStore,
  type QuickTicketStoreState,
} from "@/stores/quick-ticket.store";
import QuickTicketButton from "./QuickTicketButton";

const RESET_STATE: QuickTicketStoreState = {
  open: false,
  lifecycleRevision: 0,
  bugMode: false,
  draft: null,
  draftStashed: false,
  draftRestored: false,
  contextSnapshot: null,
  conversationRegistry: [],
};

beforeEach(() => {
  useQuickTicketStore.setState(RESET_STATE);
  window.history.replaceState({}, "", "/projects/command-center?focus=active");
});

describe("QuickTicketButton", () => {
  it("renders the quiet desktop affordance with registry-owned shortcut copy", async () => {
    const user = userEvent.setup();
    render(<QuickTicketButton pathname="/projects/command-center" />);

    const button = screen.getByRole("button", { name: "Quick ticket" });
    expect(button).not.toHaveAttribute("data-tooltip");
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `Quick ticket · ${formatHotkeyDisplay(HOTKEY_REGISTRY.quickTicket.keys)}`,
    );
    expect(button).toHaveClass("max-768:hidden");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("opens with a context snapshot from the current location", async () => {
    const user = userEvent.setup();
    render(<QuickTicketButton pathname="/projects/command-center" />);

    await user.click(screen.getByRole("button", { name: "Quick ticket" }));

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      contextSnapshot: { projectName: "command-center" },
      draft: { projectName: "command-center" },
    });
  });

  it("gives the menu-item icon an intrinsic size so the mobile menu cannot inflate it", async () => {
    // Menu items apply no CSS sizing to child SVGs (unlike IconButton), so an
    // SVG without width/height falls back to the replaced-element default of
    // 300×150 and blows out the mobile destinations menu.
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <QuickTicketButton
            pathname="/projects/command-center"
            presentation="menu-item"
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    const item = await screen.findByRole("menuitem", {
      name: /Quick ticket/,
    });
    const svg = item.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("width", "14");
    expect(svg).toHaveAttribute("height", "14");
  });

  it("does not render on an excluded route", () => {
    render(<QuickTicketButton pathname="/config" />);
    expect(screen.queryByRole("button", { name: "Quick ticket" })).toBeNull();
  });

  it("does not render while the router has no pathname", () => {
    render(<QuickTicketButton pathname={null} />);
    expect(screen.queryByRole("button", { name: "Quick ticket" })).toBeNull();
  });
});
