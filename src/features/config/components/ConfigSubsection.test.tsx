// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigSubsection } from "./ConfigSubsection";

describe("ConfigSubsection", () => {
  it("shows DEFAULT badge and default class when isDefault", () => {
    const { container } = render(
      <ConfigSubsection title="Implementer" id="implementer" isDefault>
        <span>body</span>
      </ConfigSubsection>,
    );
    const root = container.querySelector('[data-subsection="implementer"]');
    expect(root?.className).toContain("config-subsection--default");
    expect(screen.getByText("DEFAULT")).toBeVisible();
    expect(screen.getByText("Implementer")).toBeVisible();
    expect(screen.getByText("body")).toBeVisible();
  });

  it("shows MODIFIED badge and modified class when not isDefault", () => {
    const { container } = render(
      <ConfigSubsection title="x" id="x" isDefault={false}>
        <span />
      </ConfigSubsection>,
    );
    expect(
      container.querySelector('[data-subsection="x"]')?.className,
    ).toContain("config-subsection--modified");
    expect(screen.getByText("MODIFIED")).toBeVisible();
  });
});
