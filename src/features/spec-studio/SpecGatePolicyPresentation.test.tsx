// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PolicyDialog } from "./SpecControls";

describe("PolicyDialog presentation", () => {
  it("presents the dedicated gate-policy surface without an opening dialog", async () => {
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Change policy" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    const presets = screen.getByRole("radiogroup", {
      name: "Gate policy preset",
    });
    expect(
      within(presets).getByRole("radio", { name: /Contract-bearing/ }),
    ).toBeChecked();
    expect(
      within(presets).getByRole("radio", { name: /Exploratory/ }),
    ).toBeVisible();
    expect(
      within(presets).getByRole("radio", { name: /Fast path/ }),
    ).toBeVisible();

    const dials = screen.getAllByRole("radiogroup", { name: /gate mode/i });
    expect(dials).toHaveLength(5);
    const requirements = screen.getByRole("radiogroup", {
      name: "Requirements gate mode",
    });
    expect(within(requirements).getAllByRole("radio")).toHaveLength(3);
    expect(
      within(requirements).getByRole("radio", { name: "Gate" }),
    ).toBeChecked();
    expect(
      within(requirements).queryByRole("radio", { name: "Preset" }),
    ).not.toBeInTheDocument();

    await user.click(within(presets).getByRole("radio", { name: /Fast path/ }));
    await user.click(
      within(
        screen.getByRole("alertdialog", {
          name: "Gate policy change — human confirmation",
        }),
      ).getByRole("button", { name: "Confirm policy change" }),
    );
    expect(
      within(requirements)
        .getAllByRole("radio")
        .every((dial) => dial.hasAttribute("disabled")),
    ).toBe(true);

    const delivery = screen.getByRole("radiogroup", {
      name: "Delivery gate mode",
    });
    expect(within(delivery).getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(screen.getByText("Delivery can never be Off.")).toBeVisible();

    const legend = screen.getByRole("note", { name: "Dial values" });
    expect(within(legend).getByText("Gate")).toBeInTheDocument();
    expect(within(legend).getByText("Notify")).toBeInTheDocument();
    expect(within(legend).getByText("Off")).toBeInTheDocument();
    expect(
      within(legend).getByText(/Delivery is never Off/i),
    ).toBeInTheDocument();
  });
});
