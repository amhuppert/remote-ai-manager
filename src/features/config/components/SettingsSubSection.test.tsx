// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSubSection } from "./SettingsSubSection";

describe("SettingsSubSection", () => {
  it("renders title, hint, and children", () => {
    render(
      <SettingsSubSection title="Workspace" hint="Where repos live">
        <div data-testid="body">contents</div>
      </SettingsSubSection>,
    );
    expect(screen.getByText("Workspace")).toBeVisible();
    expect(screen.getByText("Where repos live")).toBeVisible();
    expect(screen.getByTestId("body")).toHaveTextContent("contents");
  });

  it("renders the hint only when provided", () => {
    const { rerender } = render(
      <SettingsSubSection title="Infrastructure">
        <span />
      </SettingsSubSection>,
    );
    expect(screen.queryByText("Where repos live")).toBeNull();
    rerender(
      <SettingsSubSection title="Infrastructure" hint="Where repos live">
        <span />
      </SettingsSubSection>,
    );
    expect(screen.getByText("Where repos live")).toBeVisible();
  });
});
