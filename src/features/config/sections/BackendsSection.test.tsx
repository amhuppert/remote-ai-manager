// @vitest-environment jsdom

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { renderWithQuery } from "@/test/component-mocks";

import { BackendsSection } from "./BackendsSection";
import { makeController } from "./test-controller";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

function chooseSelectValue(fieldPath: string, option: string): void {
  const field = document.querySelector(`[data-field="${fieldPath}"]`);
  const select = field?.querySelector('[role="combobox"]');
  if (!(select instanceof HTMLElement))
    throw new Error(`no select in ${fieldPath}`);
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("BackendsSection", () => {
  it("edits one complete model selection field for every registered backend", () => {
    const { controller } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    for (const entry of listBackendCatalogEntries()) {
      expect(
        screen
          .getByText(`${entry.label} model selection`)
          .closest("[data-field]"),
      ).toHaveAttribute(
        "data-field",
        `agentBackends.${entry.id}.modelSelection`,
      );
      expect(screen.getByText(`${entry.label} timeout`)).toBeVisible();
    }
  });

  it("replaces the whole Claude selection when the model changes", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    chooseSelectValue("agentBackends.claude.modelSelection", "Haiku");

    expect(getState().agentBackends.claude.modelSelection).toEqual({
      modelId: "haiku",
      parameters: {},
    });
  });

  it("stores an advanced Codex parameter only inside the atomic selection", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[1]!);

    expect(getState().agentBackends.codex.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "true" },
    });
    expect(getState().agentBackends.codex).not.toHaveProperty("fastMode");
  });

  it("renders no persisted credential field", () => {
    const { controller } = makeController();
    const { container } = renderWithQuery(
      <BackendsSection controller={controller} />,
    );

    expect(
      screen.queryByText(/api key|apikey|credential|token|secret/i),
    ).not.toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("keeps timeout edits isolated from model selections", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const cursorInput = document.querySelector(
      '[data-field="agentBackends.cursor.timeoutMs"] input',
    );
    if (!(cursorInput instanceof HTMLInputElement)) {
      throw new Error("no Cursor timeout input");
    }
    fireEvent.change(cursorInput, { target: { value: "30" } });

    expect(getState().agentBackends.cursor.timeoutMs).toBe(1_800_000);
    expect(getState().agentBackends.cursor.modelSelection).toEqual({
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    });
  });
});
