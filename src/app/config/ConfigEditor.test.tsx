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
    preMergeTimeoutMs: 300_000,
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
  useGlobalMcpConfigQuery: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  }),
  useProjectMcpConfigQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
  useSessionMcpConfigQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
  useConversationMcpConfigQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/lib/mutations", () => ({
  useUpdateConfigMutation: () => ({
    mutate: mutateMock,
    isPending: false,
  }),
  useToggleMcpServerMutation: () => ({ mutate: vi.fn() }),
  useResetMcpServerMutation: () => ({ mutate: vi.fn() }),
  useToggleMcpToolMutation: () => ({ mutate: vi.fn() }),
  useResetMcpToolMutation: () => ({ mutate: vi.fn() }),
  useRefreshMcpToolsMutation: () => ({ mutate: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentData = structuredClone(fullConfigData);
});

function selectSettingsTab(name: RegExp | string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function expandWorkflowDefaults() {
  selectSettingsTab(/Workflow defaults/i);
}

describe("ConfigEditor — Workflow Defaults", () => {
  it("uses the redesigned settings shell with General as the default section", () => {
    renderWithQuery(<ConfigEditor />);

    expect(
      screen.getByRole("navigation", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /General/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: /General settings/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("System Configuration")).not.toBeInTheDocument();
  });

  it("switches side-nav sections without leaving old sections underneath", () => {
    renderWithQuery(<ConfigEditor />);

    selectSettingsTab(/Capabilities/i);

    expect(screen.getByRole("tab", { name: /Capabilities/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: /Agent capabilities/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /MCP Servers/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /General settings/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("System Configuration")).not.toBeInTheDocument();
  });

  it("renders config section headers as static chrome instead of expandable controls", () => {
    renderWithQuery(<ConfigEditor />);

    expect(
      screen.queryByRole("button", { name: /Workspace/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Workspace$/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Infrastructure/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Infrastructure$/i)).toBeVisible();
  });

  it("renders workflow defaults directly at the page top level", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    selectSettingsTab(/Workflow defaults/i);

    expect(
      screen.queryByRole("button", { name: /Workflow Defaults/i }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll(".config-section")).toHaveLength(0);
    expect(container.querySelectorAll(".config-section-header")).toHaveLength(
      0,
    );
    expect(
      screen.queryByRole("button", { name: /Implementer/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Implementer$/i)).toBeVisible();
    expect(
      container.querySelectorAll(".config-subsection.collapsed"),
    ).toHaveLength(0);
  });

  it("renders all six workflow default blocks at the page top level", () => {
    renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const expected = [
      "Implementer",
      "Context validator",
      "Script validator",
      "Iteration policy",
      "Circuit breaker",
      "Mutability",
    ];
    for (const title of expected) {
      expect(screen.getByText(new RegExp(`^${title}$`, "i"))).toBeVisible();
    }
  });

  it("applies the .config-subsection class to every sub-section", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const subs = container.querySelectorAll(".config-subsection");
    expect(subs.length).toBe(6);
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

  it("switching the implementer model to Haiku does not crash and disables effort editing", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;
    const modelTrigger = implementer.querySelector(
      ".model-selector-trigger",
    ) as HTMLElement;

    fireEvent.click(modelTrigger);
    const haikuOption = Array.from(
      document.querySelectorAll(
        ".model-selector-dropdown.open .model-selector-option",
      ),
    ).find((button) => (button.textContent ?? "").startsWith("Haiku"));
    expect(haikuOption).toBeTruthy();
    fireEvent.click(haikuOption as HTMLElement);

    expect(
      implementer.querySelector(".model-selector-label")?.textContent,
    ).toBe("Haiku");

    const effortTrigger = implementer.querySelector(
      ".effort-selector-trigger",
    ) as HTMLButtonElement;
    expect(effortTrigger).toBeDisabled();
    expect(
      implementer.querySelector(".effort-selector-label")?.textContent,
    ).toBe("Unavailable");
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
    expect(defaults).toEqual({
      implementer: expect.objectContaining({ model: "sonnet" }),
    });
  });

  it("marks the Script validator sub-section modified and saves only that block after enabling it", () => {
    const { container } = renderWithQuery(<ConfigEditor />);
    expandWorkflowDefaults();

    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    ) as HTMLElement;
    expect(scriptValidator.className).toContain("config-subsection--default");

    const toggle = scriptValidator.querySelector(
      '[role="switch"]',
    ) as HTMLElement;
    fireEvent.click(toggle);

    expect(scriptValidator.className).toContain("config-subsection--modified");

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    fireEvent.click(saveBtn);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const [payload] = mutateMock.mock.calls[0]!;
    const defaults = (payload as GlobalConfig).workflowDefaults;
    expect(defaults).toEqual({
      scriptValidator: { enabled: true },
    });
  });
});
