// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KebabMenu from "./KebabMenu";

Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("KebabMenu", () => {
  it("maps a destructive item to its click handler and danger treatment", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<KebabMenu items={[{ label: "Delete", danger: true, onClick }]} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const item = screen.getByRole("menuitem", { name: "Delete" });
    expect(item.className).toContain("text-red");
    await user.click(item);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
