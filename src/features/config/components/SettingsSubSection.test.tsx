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

  it("omits hint element when hint is not provided", () => {
    const { container } = render(
      <SettingsSubSection title="Infrastructure">
        <span />
      </SettingsSubSection>,
    );
    expect(container.querySelector(".config-section-hint")).toBeNull();
  });
});
