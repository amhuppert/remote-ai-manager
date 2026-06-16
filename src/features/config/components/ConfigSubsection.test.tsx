// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigSubsection } from "./ConfigSubsection";

describe("ConfigSubsection", () => {
  it("shows DEFAULT badge when isDefault", () => {
    render(
      <ConfigSubsection title="Implementer" id="implementer" isDefault>
        <span>body</span>
      </ConfigSubsection>,
    );
    expect(screen.getByText("DEFAULT")).toBeVisible();
    expect(screen.getByText("Implementer")).toBeVisible();
    expect(screen.getByText("body")).toBeVisible();
  });

  it("shows MODIFIED badge when not isDefault", () => {
    render(
      <ConfigSubsection title="x" id="x" isDefault={false}>
        <span />
      </ConfigSubsection>,
    );
    expect(screen.getByText("MODIFIED")).toBeVisible();
  });
});
