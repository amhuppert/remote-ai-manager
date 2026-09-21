// @vitest-environment jsdom

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createTestQueryClient,
  renderWithQuery as renderQuery,
} from "@/test/component-mocks";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";

function renderWithQuery(
  ui: React.ReactElement,
  options: { taskless?: boolean; standardOnly?: boolean } = {},
) {
  const client = createTestQueryClient();
  client.setQueryData(
    backendCatalogKeys.catalog(),
    listBackendCatalogEntries().map((entry) =>
      options.taskless && entry.id === "cursor"
        ? {
            ...entry,
            facets: { ...entry.facets, tasks: false },
            execution: { ...entry.execution, tasks: null },
          }
        : options.standardOnly && entry.id === "cursor" && entry.execution.tasks
          ? {
              ...entry,
              execution: {
                ...entry.execution,
                tasks: {
                  ...entry.execution.tasks,
                  profiles: entry.execution.tasks.profiles.filter(
                    (profile) => profile === "standard",
                  ),
                },
              },
            }
          : entry,
    ),
  );
  return renderQuery(ui, client);
}

import { CompactionSection } from "./CompactionSection";
import { makeController } from "./test-controller";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

function pillIn(fieldPath: string, text: string): HTMLButtonElement {
  const field = document.querySelector(`[data-field="${fieldPath}"]`)!;
  const button = [...field.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`no "${text}" pill in ${fieldPath}`);
  return button as HTMLButtonElement;
}

function selectModel(fieldPath: string, label: string): void {
  const field = document.querySelector(`[data-field="${fieldPath}"]`);
  const select = field?.querySelector('[role="combobox"][aria-label="Model"]');
  if (!(select instanceof HTMLElement))
    throw new Error(`no model select in ${fieldPath}`);
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("CompactionSection", () => {
  it("renders separate atomic conversation and message selections", () => {
    const { controller } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    expect(screen.getByText("Checkpoint and conversation model")).toBeVisible();
    expect(screen.getByText("Message model selection")).toBeVisible();
    expect(
      document.querySelector(
        '[data-field="compaction.conversationModelSelection"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-field="compaction.messageModelSelection"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-field="compaction.effort"]'),
    ).toBeNull();
  });

  it("shows Cursor limits without disabling its selected backend", () => {
    const selection = { modelId: "composer-2.5", parameters: { fast: "true" } };
    const { controller } = makeController({
      compaction: {
        backend: "cursor",
        conversationModelSelection: selection,
        messageModelSelection: selection,
      },
    });
    renderWithQuery(<CompactionSection controller={controller} />);
    expect(pillIn("compaction.backend", "cursor")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "limits rely on instructions",
    );
  });

  it("refuses a backend with no task facet", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />, {
      taskless: true,
    });

    const cursor = pillIn("compaction.backend", "cursor");
    expect(cursor).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cursor);

    expect(getState().compaction?.backend).toBeUndefined();
  });

  it("allows a standard-only backend for compaction", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />, {
      standardOnly: true,
    });
    const cursor = pillIn("compaction.backend", "cursor");
    expect(cursor).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cursor);
    expect(getState().compaction?.backend).toBe("cursor");
  });

  it("switches the backend and both complete selections atomically", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    fireEvent.click(pillIn("compaction.backend", "codex"));

    expect(getState().compaction).toMatchObject({
      backend: "codex",
      conversationModelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      messageModelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
    });
  });

  it("updates only the selected compaction holder with a complete default variant", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    selectModel("compaction.conversationModelSelection", "Opus 5");

    expect(getState().compaction?.conversationModelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(getState().compaction?.messageModelSelection).toBeUndefined();
  });

  it("stores timeout minutes as milliseconds", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    const input = document.querySelector(
      '[data-field="compaction.timeoutMs"] input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });

    expect(getState().compaction?.timeoutMs).toBe(300_000);
  });
});
