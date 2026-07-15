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

describe("MobilePromptToolbar sheets (ui/Dialog migration)", () => {
  it("does not mount either sheet dialog until its trigger is used", () => {
    renderToolbar();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the More sheet as a portaled modal dialog with a scrim", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(
      screen.getByRole("dialog", { name: "More options" }),
    ).toBeInTheDocument();
    // The Radix Overlay scrim is mounted — a real modal, not a CSS-toggled div.
    expect(document.querySelector("[data-cc-modal-scrim]")).not.toBeNull();
  });

  it("opens the Model + Reasoning sheet as a modal dialog", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: /^Model Opus/ }));
    expect(
      screen.getByRole("dialog", { name: "Model and reasoning" }),
    ).toBeInTheDocument();
  });

  it("dismisses the More sheet via Escape (Radix owns dismissal)", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses the More sheet via its close button", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
