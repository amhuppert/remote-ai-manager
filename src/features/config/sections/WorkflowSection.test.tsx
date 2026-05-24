// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "../form-state";
import { WorkflowSection } from "./WorkflowSection";
import { makeController } from "./test-controller";

describe("WorkflowSection", () => {
  it("renders all six default sub-sections with DEFAULT badges when matching seed", () => {
    const { controller } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const expected = [
      "Implementer",
      "Context validator",
      "Script validator",
      "Iteration policy",
      "Circuit breaker",
      "Mutability",
    ];
    for (const title of expected) {
      expect(screen.getByText(new RegExp(`^${title}$`))).toBeVisible();
    }
    const subs = container.querySelectorAll(".config-subsection");
    expect(subs.length).toBe(6);
    for (const el of subs) {
      expect(el.className).toContain("config-subsection--default");
    }
  });

  it("flags a block as MODIFIED when its value differs from seeded defaults", () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      iterationPolicy: {
        maxIterations: 99,
        continuity: { enabled: true },
      },
    };
    const { controller } = makeController({ workflowDefaults: customDefaults });
    const { container } = render(<WorkflowSection controller={controller} />);
    const iteration = container.querySelector(
      '[data-subsection="iterationPolicy"]',
    );
    expect(iteration?.className).toContain("config-subsection--modified");
    expect(
      iteration?.querySelector(".config-subsection-badge")?.textContent,
    ).toBe("MODIFIED");
    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    );
    expect(implementer?.className).toContain("config-subsection--default");
  });

  it("toggling the Script validator updates only that block via the controller", () => {
    const { controller, getState } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    )! as HTMLElement;
    const toggle = scriptValidator.querySelector(
      '[role="switch"]',
    )! as HTMLElement;
    fireEvent.click(toggle);
    expect(getState().workflowDefaults?.scriptValidator?.enabled).toBe(true);
  });

  it("does not render the literal 'disabled' or 'use' kind labels in the validator", () => {
    const { controller } = makeController();
    const { container } = render(<WorkflowSection controller={controller} />);
    const validator = container.querySelector(
      '[data-subsection="contextValidator"]',
    );
    const pillLabels = validator!.querySelectorAll(".config-pill-btn");
    const texts = Array.from(pillLabels).map((el) =>
      (el.textContent ?? "").trim().toLowerCase(),
    );
    expect(texts).not.toContain("disabled");
    expect(texts).not.toContain("use");
  });
});
