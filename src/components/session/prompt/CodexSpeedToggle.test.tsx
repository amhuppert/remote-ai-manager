// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CodexSpeedToggle from "./CodexSpeedToggle";

afterEach(cleanup);

describe("CodexSpeedToggle", () => {
  it("presents Standard and Fast as an exclusive Codex speed choice", () => {
    render(<CodexSpeedToggle fastMode={false} onFastModeChange={vi.fn()} />);

    expect(
      screen.getByRole("radiogroup", { name: "Codex speed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reports the selected boolean without owning the value", async () => {
    const user = userEvent.setup();
    const onFastModeChange = vi.fn();
    render(
      <CodexSpeedToggle fastMode={false} onFastModeChange={onFastModeChange} />,
    );

    await user.click(screen.getByRole("radio", { name: "Fast" }));

    expect(onFastModeChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("disables both choices when prompt controls are unavailable", () => {
    render(<CodexSpeedToggle fastMode onFastModeChange={vi.fn()} disabled />);

    for (const option of screen.getAllByRole("radio")) {
      expect(option).toBeDisabled();
    }
  });
});
