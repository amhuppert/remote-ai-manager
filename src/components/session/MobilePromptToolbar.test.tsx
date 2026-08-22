// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test/component-mocks";
import MobilePromptToolbar, {
  type MobilePromptToolbarProps,
} from "./MobilePromptToolbar";

// The sheets compose ui/Dialog (Radix) — it manages focus / scroll-lock on open
// and jsdom implements none of the pointer-capture APIs Radix reaches for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const baseProps: MobilePromptToolbarProps = {
  modelOptions: [
    { id: "opus", label: "Opus", description: "Most capable" },
    { id: "sonnet", label: "Sonnet", description: "Balanced" },
  ],
  effortOptions: [
    { id: "high", label: "High", description: "Default" },
    { id: "max", label: "Max", description: "Maximum" },
  ],
  selectedModel: "opus",
  selectedEffort: "high",
  effortSupported: true,
  onSelectModel: vi.fn(),
  onSelectEffort: vi.fn(),
  backend: "claude",
  backendLocked: false,
  onSelectBackend: vi.fn(),
  codexFastMode: false,
  onCodexFastModeChange: vi.fn(),
  onAttach: vi.fn(),
  debugActive: false,
  debugSupported: true,
  onToggleDebug: vi.fn(),
  voiceButton: <button type="button">voice</button>,
  sendButton: <button type="button">send</button>,
};

function renderToolbar(overrides: Partial<MobilePromptToolbarProps> = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MobilePromptToolbar {...baseProps} {...overrides} />
    </QueryClientProvider>,
  );
}

describe("MobilePromptToolbar sheet open-state reporting", () => {
  // The sheets are portaled outside the composer's DOM region, so the composer
  // only knows a sheet is open through this report; without it the composer
  // collapses on the first sheet interaction and unmounts the sheet.
  it("reports open on sheet open and closed on dismissal", () => {
    const onSheetOpenChange = vi.fn();
    renderToolbar({ onSheetOpenChange });
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("reports open for the Model + Reasoning sheet too", () => {
    const onSheetOpenChange = vi.fn();
    renderToolbar({ onSheetOpenChange });
    fireEvent.click(screen.getByRole("button", { name: /^Model Opus/ }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("releases the report when the toolbar unmounts while a sheet is open", () => {
    const onSheetOpenChange = vi.fn();
    const { unmount } = renderToolbar({ onSheetOpenChange });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("MobilePromptToolbar Codex speed", () => {
  it("does not show speed configuration for Claude", () => {
    renderToolbar({ backend: "claude" });
    fireEvent.click(screen.getByRole("button", { name: /^Model Opus/ }));

    expect(
      screen.queryByRole("radiogroup", { name: "Codex speed" }),
    ).toBeNull();
    expect(screen.queryByText("Speed")).toBeNull();
  });

  it("shows a Speed section for Codex and changes its conversation value", () => {
    const onCodexFastModeChange = vi.fn();
    renderToolbar({
      backend: "codex",
      codexFastMode: true,
      onCodexFastModeChange,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Model Opus, reasoning High, speed Fast",
      }),
    );

    expect(screen.getByText("Speed")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", {
        name: "Speed, model, and reasoning",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
    expect(onCodexFastModeChange).toHaveBeenCalledWith(false);
  });
});

describe("MobilePromptToolbar project-scoped model options", () => {
  const PROJECT_OPTIONS = {
    backend: "cursor" as const,
    models: [
      {
        id: "composer-1",
        label: "composer-1",
        description: "Configured for this project.",
        effortLevels: [],
      },
    ],
    defaultModelId: "composer-1",
    source: "project" as const,
  };

  it("offers only the project's models in the settings sheet", () => {
    renderToolbar({
      backend: "cursor",
      selectedModel: "composer-1",
      projectOptions: PROJECT_OPTIONS,
      effortSupported: false,
    });

    fireEvent.click(screen.getByTestId("mobile-prompt-model-chip"));
    expect(screen.getByRole("radio", { name: /composer-1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("radio", { name: /composer-2\.5/ })).toBeNull();
  });

  it("marks the chip invalid when the selection is outside the project's list", () => {
    // No substitution: the chip must not read as if a permitted model were in
    // use, because the API is about to refuse this one.
    renderToolbar({
      backend: "cursor",
      selectedModel: "composer-2.5",
      projectOptions: PROJECT_OPTIONS,
      effortSupported: false,
    });

    const chip = screen.getByTestId("mobile-prompt-model-chip");
    expect(chip).toHaveAttribute("data-invalid-selection", "true");
    expect(chip.getAttribute("aria-label")).toContain("composer-2.5");
    expect(chip.getAttribute("aria-label")).toMatch(
      /not available|unavailable/i,
    );
  });

  it("explains the mismatch and asks for a choice in the settings sheet", () => {
    renderToolbar({
      backend: "cursor",
      selectedModel: "composer-2.5",
      projectOptions: PROJECT_OPTIONS,
      effortSupported: false,
    });

    fireEvent.click(screen.getByTestId("mobile-prompt-model-chip"));
    const notice = screen.getByTestId("mobile-prompt-model-invalid");
    expect(notice.textContent).toContain("composer-2.5");
    expect(notice.textContent).toContain("composer-1");
    expect(screen.getByRole("radio", { name: /composer-1/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("states that nothing is available when the project permits no model", () => {
    renderToolbar({
      backend: "cursor",
      selectedModel: "composer-2.5",
      projectOptions: { ...PROJECT_OPTIONS, models: [], defaultModelId: null },
      effortSupported: false,
    });

    const chip = screen.getByTestId("mobile-prompt-model-chip");
    expect(chip).toHaveAttribute("data-invalid-selection", "true");
    fireEvent.click(chip);
    expect(
      screen.getByTestId("mobile-prompt-model-invalid").textContent,
    ).toMatch(/permits no|no model/i);
  });

  it("leaves the catalog behavior unchanged when no project options are supplied", () => {
    renderToolbar({ selectedModel: "opus" });

    const chip = screen.getByTestId("mobile-prompt-model-chip");
    expect(chip).not.toHaveAttribute("data-invalid-selection");
    expect(chip.textContent).toContain("Opus");
  });
});
