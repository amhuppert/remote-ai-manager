// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  it("renders title, accent, subtitle, and body content", () => {
    render(
      <SettingsPage title="General" accent="settings" sub="Filesystem layout.">
        <div data-testid="body">body content</div>
      </SettingsPage>,
    );
    const heading = screen.getByRole("heading", { name: /General settings/i });
    expect(heading).toBeVisible();
    expect(screen.getByText("Filesystem layout.")).toBeVisible();
    expect(screen.getByTestId("body")).toHaveTextContent("body content");
  });
});
