// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";

import * as stories from "./AgentCapabilityPanel.stories";

beforeAll(storybookAnnotations.beforeAll);

const {
  NativeInheritedOverridden,
  ParentStalePendingFailedDiagnostic,
  UnavailableCodexPlugins,
  InteractiveRegression,
  ErrorRendering,
} = composeStories(stories);

describe("AgentCapabilityPanel stories", () => {
  it("renders native, inherited, and overridden rows", async () => {
    await NativeInheritedOverridden.run();
    expect(screen.getByText("Native Skill")).toBeInTheDocument();
    expect(screen.getByText("Inherited Skill")).toBeInTheDocument();
    expect(screen.getByText("Overridden Skill")).toBeInTheDocument();
  });

  it("renders parent-disabled, stale, pending, failed, and diagnostic states", async () => {
    await ParentStalePendingFailedDiagnostic.run();
    expect(screen.getByText("Parent Disabled Skill")).toBeInTheDocument();
    expect(screen.getByText("Stale Stored Skill")).toBeInTheDocument();
    expect(screen.getByText("staged idle")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(
      screen.getByText("Apply failed during idle reload."),
    ).toBeInTheDocument();
  });

  it("renders unavailable Codex plugin controls as disabled", async () => {
    await UnavailableCodexPlugins.run();
    const row = screen.getByTestId("capability-row-codex-plugin-a");
    expect(
      within(row).getByRole("button", { name: "Enable Codex Plugin A" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Codex plugin support is pending verification."),
    ).toBeInTheDocument();
  });

  it("covers search, filters, layer switching, toggle, reset, refresh, and compact long text", async () => {
    await InteractiveRegression.run();

    fireEvent.change(screen.getByLabelText("Search Claude Skills"), {
      target: { value: "long" },
    });
    expect(screen.getByText(/Long Identifier/)).toBeInTheDocument();
    expect(screen.queryByText("Native Skill")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search Claude Skills"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("Show stale"));
    expect(screen.getByText("Stale Stored Skill")).toBeInTheDocument();
    expect(screen.queryByText("Native Skill")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show stale"));

    fireEvent.change(screen.getByLabelText("Edited layer"), {
      target: { value: "project:remote-ai-manager" },
    });

    const row = screen.getByTestId(
      "capability-row-long-unbroken-capability-identifier-with-diagnostics",
    );
    fireEvent.click(
      within(row).getByRole("button", { name: /Disable Long Identifier/ }),
    );
    fireEvent.click(
      within(row).getByRole("button", { name: /Reset Long Identifier/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const compactId = within(row)
      .getAllByText(/long-unbroken/)
      .find((element) =>
        element.className.includes("agent-capability-row__id"),
      );
    expect(compactId?.className).toContain("agent-capability-row__id");
  });

  it("renders query and mutation errors", async () => {
    await ErrorRendering.run();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Capability view could not be loaded.",
    );
  });
});
