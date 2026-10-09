// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ContextHalt } from "@/components/runs/model";
import { HaltCard } from "./HaltCard";

const halt: ContextHalt = {
  kind: "turn_failed",
  occurrence: "halt-visible-7",
  detail: "The turn stopped.",
  at: "2026-10-08T19:41:00.000Z",
  remedies: [{ kind: "continue" }],
};

describe("HaltCard decisions", () => {
  it("binds the remedy to the halt occurrence that was rendered", async () => {
    const onApply = vi.fn();
    render(<HaltCard halt={halt} onApply={onApply} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    expect(onApply).toHaveBeenCalledWith({
      occurrence: "halt-visible-7",
      remedy: { kind: "continue" },
    });
  });

  it("allows replacing a grant count and clamps its maximum on blur", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <HaltCard
        halt={{
          ...halt,
          kind: "retries_exhausted",
          remedies: [
            {
              kind: "grant",
              allowance: "validationRetries",
              used: 3,
              limit: 3,
            },
          ],
        }}
        onApply={onApply}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Allow more review retries/ }),
    );
    const count = screen.getByRole("spinbutton", { name: "More retries" });
    await user.clear(count);
    expect(count).toHaveValue(null);
    await user.type(count, "14");
    await user.tab();
    expect(count).toHaveValue(9);
    await user.type(
      screen.getByRole("textbox", { name: "Reason" }),
      "The latest run made progress.",
    );
    await user.click(
      within(screen.getByRole("form", { name: "Apply remedy" })).getByRole(
        "button",
        { name: "Allow more review retries" },
      ),
    );
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: "halt-visible-7", count: 9 }),
    );
  });
});
