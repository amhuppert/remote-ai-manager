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
  DropdownMenuSeparator,
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

  it("renders items with the CC menu-item recipe; danger maps to the red treatment", () => {
    openMenu(
      <>
        <DropdownMenuItem>Rename</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger>Delete</DropdownMenuItem>
      </>,
    );

    const rename = screen.getByRole("menuitem", { name: "Rename" });
    expect(rename.className).toContain("font-mono");
    expect(rename.className).toContain("text-text-primary");
    expect(rename.className).toContain(
      "data-[highlighted]:bg-[var(--cc-cyan-a08)]",
    );
    expect(rename.className).toContain("data-[disabled]:opacity-40");
    // Keyboard focus ring (mouse hover stays clean via :focus-visible).
    expect(rename.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );

    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(del.className).toContain("text-red");
    expect(del.className).toContain(
      "data-[highlighted]:bg-[var(--cc-red-a10)]",
    );
  });

  it("content carries the elevated menu surface and appends layoutClassName last", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
        <DropdownMenuContent layoutClassName="w-[320px]">
          <DropdownMenuItem>x</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("bg-bg-elevated");
    expect(menu.className).toContain("border-border-default");
    expect(menu.className).toContain("shadow-menu");
    expect(menu.className).toContain("z-menu");
    expect(menu.className.trim().endsWith("w-[320px]")).toBe(true);
  });

  it("radio items take the cyan-glow checked treatment via data-state", () => {
    openMenu(
      <DropdownMenuRadioGroup value="opus">
        <DropdownMenuRadioItem value="opus">Opus</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="haiku">Haiku</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>,
    );

    const opus = screen.getByRole("menuitemradio", { name: "Opus" });
    expect(opus.getAttribute("data-state")).toBe("checked");
    expect(opus.className).toContain("data-[state=checked]:bg-cyan-glow");
    expect(opus.className).toContain("data-[state=checked]:text-cyan");

    const haiku = screen.getByRole("menuitemradio", { name: "Haiku" });
    expect(haiku.getAttribute("data-state")).toBe("unchecked");
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
    // data-state=open on the underlying <button> proves the asChild ref/prop
    // merge reached the Button primitive's DOM node.
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(screen.getByRole("menuitem", { name: "One" })).toBeInTheDocument();
  });
});
