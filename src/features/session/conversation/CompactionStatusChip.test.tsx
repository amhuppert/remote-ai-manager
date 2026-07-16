// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CompactionStatusChip from "./CompactionStatusChip";

afterEach(cleanup);

describe("CompactionStatusChip — labels + activation", () => {
  it("renders the none label and opens the artifact panel on click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<CompactionStatusChip state={{ kind: "none" }} onOpen={onOpen} />);
    const el = screen.getByRole("button", {
      name: "Context artifact: No compact",
    });
    await user.click(el);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the stale label with its behind count", () => {
    render(
      <CompactionStatusChip
        state={{ kind: "stale", behind: 7 }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Stale (behind 7)");
  });
});
