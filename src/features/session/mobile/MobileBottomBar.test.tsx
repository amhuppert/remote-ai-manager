// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import MobileBottomBar, {
  type MobileBottomBarProps,
  type MobilePanelTab,
} from "@/features/session/mobile/MobileBottomBar";

function makeProps(
  overrides: Partial<MobileBottomBarProps> = {},
): MobileBottomBarProps {
  return {
    mobilePanel: "chat",
    onSwitchPanel: vi.fn(),
    tddEnabled: false,
    onTddToggle: vi.fn(),
    tddDisabled: false,
    onDelete: vi.fn(),
    devServerCounts: { running: 0, total: 0 },
    onDevServers: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MobileBottomBar", () => {
  it("opens secondary conversation panels from session actions", () => {
    const onSwitchPanel = vi.fn();
    render(<MobileBottomBar {...makeProps({ onSwitchPanel })} />);
    for (const [label, panel] of [
      ["Alignment", "alignment"],
      ["Memory", "memory"],
      ["Compactions", "artifact"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onSwitchPanel).toHaveBeenLastCalledWith(panel);
      expect(
        screen.queryByRole("button", { name: "Close menu" }),
      ).not.toBeInTheDocument();
    }
  });
  it("keeps primary panels visible and secondary panels in More", () => {
    render(<MobileBottomBar {...makeProps()} />);
    for (const label of ["Chat", "Diff", "Docs"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the tab matching mobilePanel as active", () => {
    render(<MobileBottomBar {...makeProps({ mobilePanel: "diff" })} />);
    const diff = screen.getByRole("button", { name: "Diff" });
    expect(diff.className).toBe("cc-tab active");

    const chat = screen.getByRole("button", { name: "Chat" });
    expect(chat.className).toBe("cc-tab");
  });

  it("calls onSwitchPanel with the tab id when a tab is clicked", () => {
    const onSwitchPanel = vi.fn();
    render(<MobileBottomBar {...makeProps({ onSwitchPanel })} />);

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(onSwitchPanel).toHaveBeenLastCalledWith(
      "docs" satisfies MobilePanelTab,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Specs" }));
    expect(onSwitchPanel).toHaveBeenLastCalledWith(
      "specs" satisfies MobilePanelTab,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(onSwitchPanel).toHaveBeenLastCalledWith(
      "info" satisfies MobilePanelTab,
    );

    expect(onSwitchPanel).toHaveBeenCalledTimes(3);
  });

  it("does not fire onSwitchPanel until a tab is clicked", () => {
    const onSwitchPanel = vi.fn();
    render(<MobileBottomBar {...makeProps({ onSwitchPanel })} />);
    expect(onSwitchPanel).not.toHaveBeenCalled();
  });
});
