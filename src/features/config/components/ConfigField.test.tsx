// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigField } from "./ConfigField";

describe("ConfigField", () => {
  it("renders label, hint, and children", () => {
    render(
      <ConfigField
        label="Base directory"
        fieldPath="baseDir"
        isDefault={false}
        isModified={false}
        hint="Where projects live"
      >
        <input data-testid="input" />
      </ConfigField>,
    );
    expect(screen.getByText("Base directory")).toBeVisible();
    expect(screen.getByText("Where projects live")).toBeVisible();
    expect(screen.getByTestId("input")).toBeInTheDocument();
  });

  it("shows DEFAULT badge when isDefault", () => {
    render(
      <ConfigField label="x" fieldPath="x" isDefault isModified={false}>
        <span />
      </ConfigField>,
    );
    expect(screen.getByText("DEFAULT")).toBeVisible();
  });

  it("shows LOCKED badge and read-only class when readOnly", () => {
    const { container } = render(
      <ConfigField
        label="x"
        fieldPath="x"
        isDefault={false}
        isModified={false}
        readOnly
      >
        <span />
      </ConfigField>,
    );
    expect(screen.getByText("LOCKED")).toBeVisible();
    expect(container.querySelector(".config-field-readonly")).toBeTruthy();
  });

  it("applies modified class when isModified", () => {
    const { container } = render(
      <ConfigField label="x" fieldPath="x" isDefault={false} isModified>
        <span />
      </ConfigField>,
    );
    expect(container.querySelector(".config-field.modified")).toBeTruthy();
  });
});
