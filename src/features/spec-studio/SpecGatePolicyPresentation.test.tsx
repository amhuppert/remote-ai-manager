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

    const dials = screen.getAllByRole("combobox");
    expect(dials).toHaveLength(4);
    expect(screen.queryByRole("combobox", { name: "Plan" })).toBeNull();
    const requirements = screen.getByRole("combobox", {
      name: "Requirements",
    });
    expect(requirements).toHaveTextContent("Inherit (gate)");

    await user.click(within(presets).getByRole("radio", { name: /Fast path/ }));
    await user.click(
      screen.getByRole("button", { name: "Review policy change" }),
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", {
          name: "Confirm gate policy change",
        }),
      ).getByRole("button", { name: "Confirm policy change" }),
    );

    const delivery = screen.getByRole("combobox", {
      name: "Delivery",
    });
    await user.click(delivery);
    expect(await screen.findByRole("option", { name: "Off" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Delivery can never be Off.")).toBeVisible();
  });
});
