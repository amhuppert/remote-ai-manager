// @vitest-environment jsdom

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createTestQueryClient,
  renderWithQuery as renderQuery,
} from "@/test/component-mocks";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";

function renderWithQuery(ui: React.ReactElement, taskless = false) {
  const client = createTestQueryClient();
  client.setQueryData(
    backendCatalogKeys.catalog(),
    listBackendCatalogEntries().map((entry) =>
      taskless && entry.id === "cursor"
        ? {
            ...entry,
            facets: { ...entry.facets, tasks: false },
            execution: { ...entry.execution, tasks: null },
          }
        : entry,
    ),
  );
  return renderQuery(ui, client);
}

import { NamingSection } from "./NamingSection";
import { makeController } from "./test-controller";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

function pillIn(fieldPath: string, text: string): HTMLButtonElement {
  const field = document.querySelector(`[data-field="${fieldPath}"]`);
  if (!(field instanceof HTMLElement)) {
    throw new Error(`no field ${fieldPath}`);
  }
  const button = [...field.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`no "${text}" pill in ${fieldPath}`);
  }
  return button;
}

function selectModel(label: string): void {
  const field = document.querySelector(
    '[data-field="conversationNaming.modelSelection"]',
  );
  const select = field?.querySelector('[role="combobox"][aria-label="Model"]');
  if (!(select instanceof HTMLElement)) {
    throw new Error("no conversation naming model select");
  }
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("option", { name: label }));
}

function timeoutInput(): HTMLInputElement {
  const input = document.querySelector(
    '[data-field="conversationNaming.timeoutMs"] input',
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("no conversationNaming.timeoutMs input");
  }
  return input;
}

describe("NamingSection", () => {
  it("renders one complete model-selection field", () => {
    const { controller } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    expect(
      document.querySelector(
        '[data-field="conversationNaming.modelSelection"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-field="conversationNaming.model"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-field="conversationNaming.effort"]'),
    ).toBeNull();
  });

  it("refuses a backend with no task facet and keeps the configured one", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />, true);

    const cursor = pillIn("conversationNaming.backend", "cursor");
    expect(cursor).toHaveAttribute("aria-disabled", "true");
    expect(cursor).toHaveAttribute("title", expect.stringContaining("task"));

    fireEvent.click(cursor);
    expect(getState().conversationNaming?.backend).toBeUndefined();
  });

  it("defaults to the Claude Haiku selection when config has no naming block", () => {
    const { controller } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "Haiku",
    );
  });

  it("switches backend and replaces the complete model selection", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(pillIn("conversationNaming.backend", "codex"));

    expect(getState().conversationNaming).toMatchObject({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
    });
  });

  it("selecting a model replaces only the complete selection field", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    selectModel("Sonnet");

    expect(getState().conversationNaming?.modelSelection).toEqual({
      modelId: "sonnet",
      parameters: { effort: "high" },
    });
    expect(getState().conversationNaming?.backend).toBeUndefined();
  });

  it("toggling enabled writes conversationNaming.enabled", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(screen.getByRole("switch", { name: /automatic naming/i }));

    expect(getState().conversationNaming?.enabled).toBe(false);
  });

  it("stores entered timeout minutes as milliseconds", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.change(timeoutInput(), { target: { value: "5" } });

    expect(getState().conversationNaming?.timeoutMs).toBe(300_000);
  });

  it("clears an explicit timeout to the null fallback sentinel", () => {
    const { controller, getState } = makeController({
      conversationNaming: {
        enabled: true,
        backend: "claude",
        modelSelection: { modelId: "haiku", parameters: {} },
        timeoutMs: 300_000,
      },
    });
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.change(timeoutInput(), { target: { value: "" } });

    expect(getState().conversationNaming?.timeoutMs).toBeNull();
  });
});
