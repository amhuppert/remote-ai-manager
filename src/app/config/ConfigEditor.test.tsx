// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import type { GlobalConfig } from "@/types";
import type { RawGlobalConfig, WorkflowDefaults } from "@/lib/schemas";
import ConfigEditor, { SEEDED_WORKFLOW_DEFAULTS } from "./ConfigEditor";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);

vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));
vi.mock("@/stores/notification.store", () => ({
  useActiveJobs: () => [],
}));

const fullConfigData: { config: GlobalConfig; raw: RawGlobalConfig } = {
  config: {
    baseDir: "/home/user/projects",
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    claudeTimeoutMs: 3_600_000,
    maxConcurrentQueries: 3,
    mergeCheckIntervalMs: 300_000,
    preMergeTimeoutMs: 300_000,
    stateFilePath: "/tmp/state.json",
    ignorePatterns: ["node_modules"],
    tailscaleEnabled: false,
    workflowDefaults: structuredClone(SEEDED_WORKFLOW_DEFAULTS),
  },
  raw: { baseDir: "/home/user/projects" },
};

let currentData: { config: GlobalConfig; raw: RawGlobalConfig } =
  structuredClone(fullConfigData);

const mutateMock = vi.fn();

vi.mock("@/lib/queries", () => ({
  useFullConfigQuery: () => ({
    data: currentData,
    isPending: false,
    isError: false,
    error: null,
  }),
  useNotificationsQuery: () => ({ data: { unreadCount: 0 } }),
}));

vi.mock("@/lib/mutations", () => ({
  useUpdateConfigMutation: () => ({
    mutate: mutateMock,
    isPending: false,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentData = structuredClone(fullConfigData);
});

function expandWorkflowDefaults() {
  // The workflowDefaults section is collapsed by default; click its header to expand.
  fireEvent.click(screen.getByRole("button", { name: /Workflow Defaults/i }));
}

describe("ConfigEditor — Workflow Defaults", () => {
  it("renders all five sub-sections inside 'Workflow Defaults'", () => {
    renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const expected = [
      "Implementer",
      "Context validator",
      "Iteration policy",
      "Circuit breaker",
      "Mutability",
    ];
    for (const title of expected) {
      expect(
        screen.getByRole("button", { name: new RegExp(title, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("applies the .config-subsection class to every sub-section", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const subs = container.querySelectorAll(".config-subsection");
    expect(subs.length).toBe(5);
    for (const el of subs) {
      expect(el.className).toMatch(/config-subsection/);
    }
  });

  it("shows [DEFAULT] on every sub-section when all fields match seeded defaults", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const subs = container.querySelectorAll(".config-subsection");
    for (const el of subs) {
      expect(el.className).toContain("config-subsection--default");
      const badge = el.querySelector(".config-subsection-badge");
      expect(badge?.textContent).toBe("DEFAULT");
    }
  });

  it("shows [MODIFIED] on a sub-section whose block differs from seeded defaults", () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      iterationPolicy: {
        maxIterations: 99,
        continuity: { enabled: true },
      },
    };
    currentData = {
      config: { ...fullConfigData.config, workflowDefaults: customDefaults },
      raw: {
        ...fullConfigData.raw,
        workflowDefaults: { iterationPolicy: customDefaults.iterationPolicy },
      },
    };

    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const iteration = container.querySelector(
      '[data-subsection="iterationPolicy"]',
    );
    expect(iteration?.className).toContain("config-subsection--modified");
    const badge = iteration?.querySelector(".config-subsection-badge");
    expect(badge?.textContent).toBe("MODIFIED");

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    );
    expect(implementer?.className).toContain("config-subsection--default");
  });

  it("never surfaces a 'disabled' kind in the Context validator sub-section", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const validator = container.querySelector(
      '[data-subsection="contextValidator"]',
    );
    expect(validator).toBeTruthy();
    // The word "disabled" must not appear as an option / pill in the sub-section.
    const pillLabels = validator!.querySelectorAll(".config-pill-btn");
    const texts = Array.from(pillLabels).map((el) =>
      (el.textContent ?? "").trim().toLowerCase(),
    );
    expect(texts).not.toContain("disabled");
    // The `kind` discriminator must not leak either.
    expect(texts).not.toContain("use");
  });

  it("marks the Implementer sub-section [MODIFIED] after editing the model", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;
    expect(implementer.className).toContain("config-subsection--default");

    // Open the ModelSelector dropdown (portal-rendered into document.body).
    // Edit implementer.model from "opus" → "sonnet" via ModelSelector.
    // Options are rendered in portals attached to document.body; click every
    // "Sonnet" option so the implementer's ModelSelector onChange fires.
    const sonnetOptions = document.querySelectorAll(".model-selector-option");
    let clicked = 0;
    for (const btn of Array.from(sonnetOptions)) {
      if ((btn.textContent ?? "").startsWith("Sonnet")) {
        fireEvent.click(btn);
        clicked++;
      }
    }
    expect(clicked).toBeGreaterThan(0);

    expect(implementer.className).toContain("config-subsection--modified");
    const badge = implementer.querySelector(".config-subsection-badge");
    expect(badge?.textContent).toBe("MODIFIED");
  });

  it("save writes only the changed blocks (unchanged workflow-defaults blocks not written)", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;

    const sonnetOptions = document.querySelectorAll(".model-selector-option");
    for (const btn of Array.from(sonnetOptions)) {
      if ((btn.textContent ?? "").startsWith("Sonnet")) {
        fireEvent.click(btn);
      }
    }

    expect(implementer.className).toContain("config-subsection--modified");

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [payload] = mutateMock.mock.calls[0]!;
    const defaults = (payload as GlobalConfig).workflowDefaults;
    expect(defaults).toBeDefined();
    // Implementer block was changed → present in payload.
    expect(defaults?.implementer?.model).toBe("sonnet");
    // Unchanged blocks (not in raw, not modified) must not be written back.
    expect(defaults?.contextValidator).toBeUndefined();
    expect(defaults?.iterationPolicy).toBeUndefined();
    expect(defaults?.circuitBreaker).toBeUndefined();
    expect(defaults?.mutability).toBeUndefined();
  });
});
