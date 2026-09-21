// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import { Button } from "./Button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./DropdownMenu";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

/** A minimal open menu with the given content (non-modal to skip scroll-lock). */
function openMenu(children: React.ReactNode) {
  return render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("DropdownMenu", () => {
  it("registers the open menu with the global overlay scope and clears it on close", () => {
    const { rerender } = openMenu(<DropdownMenuItem>x</DropdownMenuItem>);
    expect(isOverlayOpen()).toBe(true);

    rerender(
      <DropdownMenu open={false} modal={false}>
        <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>x</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(isOverlayOpen()).toBe(false);
  });

  it("exposes the selected radio item to assistive technology", () => {
    openMenu(
      <DropdownMenuRadioGroup value="opus">
        <DropdownMenuRadioItem value="opus">Opus</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="haiku">Haiku</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>,
    );

    expect(
      screen.getByRole("menuitemradio", { name: "Opus", checked: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemradio", { name: "Haiku", checked: false }),
    ).toBeInTheDocument();
  });

  it("composes with the Button primitive as an asChild trigger", () => {
    render(
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <Button>Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "One" })).toBeInTheDocument();
  });
});
