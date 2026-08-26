// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";

import {
  CatalogModelSelect,
  DesktopModelSelectionControls,
  ModelOptionsEditor,
  PrimaryModelParameterControl,
  UnavailableModelSelectionControl,
} from "./ModelSelectionControls";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const selection = {
  modelId: "constrained",
  parameters: {
    reasoning: "high",
    thinking: "false",
    context: "272k",
    fast: "true",
    cyber: "false",
    cache: "enabled",
  },
} satisfies BackendModelSelection;

const catalog = {
  backend: "cursor",
  defaultModelId: "constrained",
  models: [
    {
      id: "constrained",
      label: "Constrained model",
      description: "A model with coupled parameters.",
      aliases: [],
      parameters: [
        {
          id: "reasoning",
          label: "Reasoning",
          values: [
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
          ],
          prominence: "primary",
        },
        {
          id: "thinking",
          label: "Thinking",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
        {
          id: "context",
          label: "Context size",
          values: [
            { value: "272k", label: "272k" },
            { value: "1m", label: "1m" },
          ],
          prominence: "advanced",
        },
        {
          id: "fast",
          label: "Fast mode",
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
          prominence: "advanced",
        },
        {
          id: "cyber",
          label: "Cyber",
          values: [{ value: "false", label: "Off" }],
          prominence: "hidden",
        },
        {
          id: "cache",
          label: "Cache",
          values: [{ value: "enabled", label: "Enabled" }],
          prominence: "advanced",
        },
      ],
      variants: [
        {
          selection,
          label: "Default",
          isDefault: true,
        },
        {
          selection: {
            ...selection,
            parameters: { ...selection.parameters, fast: "false" },
          },
          label: "Standard",
          isDefault: false,
        },
        {
          selection: {
            ...selection,
            parameters: {
              ...selection.parameters,
              context: "1m",
              fast: "false",
            },
          },
          label: "Long context",
          isDefault: false,
        },
        {
          selection: {
            ...selection,
            parameters: {
              ...selection.parameters,
              reasoning: "xhigh",
              thinking: "true",
              fast: "false",
            },
          },
          label: "Extra high reasoning",
          isDefault: false,
        },
      ],
    },
    {
      id: "plain",
      label: "Plain model",
      description: "No selectable parameters.",
      aliases: [],
      parameters: [],
      variants: [
        {
          selection: { modelId: "plain", parameters: {} },
          label: "Default",
          isDefault: true,
        },
      ],
    },
  ],
  provenance: { source: "test" },
} satisfies BackendModelCatalog;

function chooseSelectValue(label: string, option: string): void {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("UnavailableModelSelectionControl", () => {
  it("keeps the raw applied model visible and explains why it is blocked", () => {
    render(
      <UnavailableModelSelectionControl
        selection={{ modelId: "composer-missing", parameters: {} }}
        reason="The Cursor catalog snapshot is unavailable."
      />,
    );

    expect(
      screen.getByRole("button", { name: /composer-missing/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "The Cursor catalog snapshot is unavailable.",
    );
  });
});

describe("CatalogModelSelect", () => {
  it("applies the selected model's complete default variant", () => {
    const onSelectionChange = vi.fn();
    render(
      <CatalogModelSelect
        catalog={catalog}
        selection={selection}
        onSelectionChange={onSelectionChange}
      />,
    );

    chooseSelectValue("Model", "Plain model");

    expect(onSelectionChange).toHaveBeenCalledWith({
      modelId: "plain",
      parameters: {},
    });
  });

  it("ignores the empty value Radix emits while the selected option tears down", () => {
    const onSelectionChange = vi.fn();
    const rendered = render(
      <form>
        <CatalogModelSelect
          catalog={catalog}
          selection={selection}
          onSelectionChange={onSelectionChange}
        />
      </form>,
    );

    const nativeSelect = document.querySelector("select");
    expect(nativeSelect).not.toBeNull();
    fireEvent.change(nativeSelect!, { target: { value: "" } });
    rendered.rerender(<></>);

    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe("PrimaryModelParameterControl", () => {
  it("opens model options instead of silently changing a coupled parameter", () => {
    const onSelectionChange = vi.fn();
    const onNeedsOptions = vi.fn();
    const parameter = catalog.models[0]!.parameters[0]!;
    render(
      <PrimaryModelParameterControl
        catalog={catalog}
        selection={selection}
        parameter={parameter}
        onSelectionChange={onSelectionChange}
        onNeedsOptions={onNeedsOptions}
      />,
    );

    chooseSelectValue("Reasoning", "Extra high");

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onNeedsOptions).toHaveBeenCalledOnce();
  });
});

describe("ModelOptionsEditor", () => {
  it("keeps coupled edits as a draft until the complete variant is valid", () => {
    const onApply = vi.fn();
    render(
      <ModelOptionsEditor
        catalog={catalog}
        selection={selection}
        onApply={onApply}
      />,
    );

    const fastMode = screen.getByRole("switch", { name: "Fast mode" });
    expect(fastMode).toHaveAttribute("aria-checked", "true");

    chooseSelectValue("Context size", "1m");

    expect(fastMode).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /unsupported combination/i,
    );
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(fastMode);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith({
      modelId: "constrained",
      parameters: {
        ...selection.parameters,
        context: "1m",
        fast: "false",
      },
    });
  });

  it("does not render hidden or fixed parameters", () => {
    render(
      <ModelOptionsEditor
        catalog={catalog}
        selection={selection}
        onApply={vi.fn()}
      />,
    );

    expect(screen.queryByText("Cyber")).toBeNull();
    expect(screen.queryByText("Cache")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Reasoning" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Thinking" })).toBeVisible();
  });

  it("discards the draft when cancelled", () => {
    const onCancel = vi.fn();
    render(
      <ModelOptionsEditor
        catalog={catalog}
        selection={selection}
        onApply={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("switch", { name: "Thinking" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});

describe("DesktopModelSelectionControls", () => {
  it("opens options with an invalid primary draft and applies the resolved selection", () => {
    const onSelectionChange = vi.fn();
    render(
      <DesktopModelSelectionControls
        catalog={catalog}
        selection={selection}
        onSelectionChange={onSelectionChange}
      />,
    );

    chooseSelectValue("Reasoning", "Extra high");
    expect(screen.getByRole("dialog", { name: "Model options" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      modelId: "constrained",
      parameters: {
        ...selection.parameters,
        reasoning: "xhigh",
        thinking: "true",
        fast: "false",
      },
    });
  });

  it("omits primary and options controls for a model without parameters", () => {
    render(
      <DesktopModelSelectionControls
        catalog={catalog}
        selection={{ modelId: "plain", parameters: {} }}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Reasoning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model options" })).toBeNull();
  });
});
