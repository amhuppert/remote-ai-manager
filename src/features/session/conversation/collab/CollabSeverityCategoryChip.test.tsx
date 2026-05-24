// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import CollabSeverityCategoryChip from "@/features/session/conversation/collab/CollabSeverityCategoryChip";

describe("CollabSeverityCategoryChip", () => {
  it("renders both segments with their data attributes", () => {
    const { container } = render(
      <CollabSeverityCategoryChip severity="blocking" category="objective" />,
    );

    const chip = container.querySelector(".collab-sev-cat-chip");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-severity")).toBe("blocking");
    expect(chip?.getAttribute("data-category")).toBe("objective");
    expect(chip?.textContent ?? "").toContain("OBJ");
    expect(chip?.textContent ?? "").toContain("BLOCKING");
  });

  it("uses the IMPL label for implementation category", () => {
    const { container } = render(
      <CollabSeverityCategoryChip severity="minor" category="implementation" />,
    );
    const chip = container.querySelector(".collab-sev-cat-chip");
    expect(chip?.textContent ?? "").toContain("IMPL");
    expect(chip?.textContent ?? "").toContain("MINOR");
  });

  it("exposes an accessible label combining category and severity", () => {
    const { container } = render(
      <CollabSeverityCategoryChip severity="major" category="implementation" />,
    );
    const chip = container.querySelector(".collab-sev-cat-chip");
    const label = chip?.getAttribute("aria-label") ?? "";
    expect(label).toContain("IMPL");
    expect(label).toContain("MAJOR");
  });
});
