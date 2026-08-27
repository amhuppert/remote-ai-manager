// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test/component-mocks";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
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

const defaultCatalog = getStaticBackendModelCatalog("claude");
const defaultSelection = defaultSelectionForModel(defaultCatalog, "opus");

const baseProps: MobilePromptToolbarProps = {
  modelCatalog: defaultCatalog,
  modelSelection: defaultSelection,
  modelSelectionBlockedReason: null,
  onModelSelectionChange: vi.fn(),
  backend: "claude",
  backendLocked: false,
  onSelectBackend: vi.fn(),
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

describe("MobilePromptToolbar model selection", () => {
  it("applies a model's complete default variant", () => {
    const modelCatalog = getStaticBackendModelCatalog("claude");
    const modelSelection = defaultSelectionForModel(modelCatalog, "opus");
    const onModelSelectionChange = vi.fn();
    renderToolbar({
      modelCatalog,
      modelSelection,
      onModelSelectionChange,
    });

    fireEvent.click(screen.getByTestId("mobile-prompt-model-chip"));
    fireEvent.click(screen.getByRole("radio", { name: /Sonnet/ }));

    expect(onModelSelectionChange).toHaveBeenCalledWith(
      defaultSelectionForModel(modelCatalog, "sonnet"),
    );
  });

  it("keeps parameter edits in the sheet until a valid draft is applied", () => {
    const modelCatalog = getStaticBackendModelCatalog("codex");
    const modelSelection = defaultSelectionForModel(
      modelCatalog,
      modelCatalog.defaultModelId,
    );
    const onModelSelectionChange = vi.fn();
    renderToolbar({
      backend: "codex",
      modelCatalog,
      modelSelection,
      onModelSelectionChange,
    });

    fireEvent.click(screen.getByTestId("mobile-prompt-model-chip"));
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    expect(onModelSelectionChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onModelSelectionChange).toHaveBeenCalledWith({
      ...modelSelection,
      parameters: { ...modelSelection.parameters, fast: "true" },
    });
  });

  it("gives the chip the rainbow border only for an above-scale applied tier", () => {
    const modelCatalog = getStaticBackendModelCatalog("claude");
    renderToolbar({
      modelCatalog,
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "max" },
      },
    });

    expect(screen.getByTestId("mobile-prompt-model-chip")).toHaveClass(
      "cc-rainbow-border",
    );

    cleanup();
    renderToolbar({
      modelCatalog,
      modelSelection: defaultSelectionForModel(modelCatalog, "opus"),
    });

    expect(screen.getByTestId("mobile-prompt-model-chip")).not.toHaveClass(
      "cc-rainbow-border",
    );
  });
});

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

  it("reports open for the model options sheet too", () => {
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
  it("shows the configured raw id and catalog diagnostic for a stale selection", () => {
    renderToolbar({
      modelSelection: { modelId: "removed-model", parameters: {} },
    });

    const chip = screen.getByTestId("mobile-prompt-model-chip");
    expect(chip).toHaveAttribute("data-invalid-selection", "true");
    expect(chip).toHaveTextContent("removed-model");

    fireEvent.click(chip);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /not present in this backend catalog/i,
    );
  });
});
