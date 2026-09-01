// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PolicyDialog } from "./SpecControls";

describe("Spec Studio gate policy controls", () => {
  it("confirms a policy change explicitly and exposes no execution controls", async () => {
    const user = userEvent.setup();
    const onChangePolicy = vi.fn();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Exploratory/ }));
    await user.click(
      screen.getByRole("button", { name: "Review policy change" }),
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Existing approvals are not manufactured",
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm policy change" }),
    );

    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
    });
    expect(screen.queryByText(/Execution starts/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /waive|merge|launch/i }),
    ).toBeNull();
  });
});
