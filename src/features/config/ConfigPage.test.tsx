// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

/** Open the given subsection's ModelSelector and pick the option whose label
 * starts with `labelPrefix` (Radix renders options only while the listbox is
 * open; they portal to document.body and carry `data-testid`). */
async function pickModel(
  user: ReturnType<typeof userEvent.setup>,
  subsection: HTMLElement,
  labelPrefix: string,
): Promise<void> {
  const trigger = subsection.querySelector(
    '[data-testid="model-selector-trigger"]',
  ) as HTMLElement;
  await user.click(trigger);
  const option = screen
    .getAllByTestId("model-selector-option")
    .find((o) => (o.textContent ?? "").startsWith(labelPrefix));
  expect(option, `no model option "${labelPrefix}"`).toBeTruthy();
  await user.click(option!);
}
import type { GlobalConfig } from "@/lib/config/schemas";
import type { RawGlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import ConfigPage, { SEEDED_WORKFLOW_DEFAULTS } from "./ConfigPage";

// next/link and next/navigation are external framework modules with no
// internal seam; the sanctioned client-test pattern (@/test/fetch-fixture)
// covers only the network boundary, so these keep their component-mock stubs.
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);

const fullConfigData: { config: GlobalConfig; raw: RawGlobalConfig } = {
  config: {
    baseDir: "/home/user/projects",
    defaultAgentBackend: "claude",
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 3_600_000,
      },
      codex: {
        fastMode: false,
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeoutMs: null,
      },
      cursor: { model: "composer-2.5", timeoutMs: null },
    },
    maxConcurrentQueries: 3,
    preMergeTimeoutMs: 300_000,
    validation: {
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    },
    ignorePatterns: ["node_modules"],
    tailscaleEnabled: false,
    workflowDefaults: structuredClone(SEEDED_WORKFLOW_DEFAULTS),
  },
  raw: { baseDir: "/home/user/projects" },
};

let api: FetchFixture;

/** Serve the full-config GET, the notifications + active-conversations GETs the
 * Topbar issues, and hold the global MCP config query in perpetual loading (the
 * Capabilities tab mounts the MCP panel; these tests never resolve it). */
function seedConfigRoutes(
  config: { config: GlobalConfig; raw: RawGlobalConfig } = fullConfigData,
): void {
  api.json("GET", "/api/config", config);
  api.json("GET", "/api/notifications", {
    notifications: [],
    total: 0,
    unreadCount: 0,
  });
  api.json("GET", "/api/conversations/active", { conversations: [] });
  api.pending("GET", "/api/config/mcp");
  api.json("GET", "/api/agent-backends", {
    backends: listBackendCatalogEntries(),
  });
}

/** The last full-config payload PUT to /api/config, parsed from the wire. */
function savedConfig(): RawGlobalConfig {
  const puts = api.requestsTo("PUT", "/api/config");
  expect(puts).toHaveLength(1);
  return puts[0]?.jsonBody as RawGlobalConfig;
}

beforeEach(() => {
  api = installFetchFixture();
  // The update mutation validates its response with fullConfigResponseSchema
  // and applySaved consumes it, so the PUT echoes a valid full config.
  api.reply("PUT", "/api/config", { json: fullConfigData });
});

afterEach(() => {
  api.restore();
  vi.clearAllMocks();
});

async function renderConfigPage(): Promise<ReturnType<typeof renderWithQuery>> {
  const result = renderWithQuery(<ConfigPage />);
  // Queries resolve asynchronously; wait for the loaded shell before asserting.
  await screen.findByRole("tablist", { name: "Settings" });
  return result;
}

function selectSettingsTab(name: RegExp | string) {
  // Radix Tabs activate on pointer-down (automatic activation), not on a bare
  // synthetic click event.
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

function expandWorkflowDefaults() {
  selectSettingsTab(/Workflow defaults/i);
}

describe("ConfigPage — Workflow Defaults", () => {
  beforeEach(() => {
    seedConfigRoutes();
  });

  it("uses the redesigned settings shell with General as the default section", async () => {
    await renderConfigPage();

    expect(screen.getByRole("tablist", { name: "Settings" })).toHaveAttribute(
      "data-orientation",
      "vertical",
    );
    expect(screen.getByRole("tab", { name: /General/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: /General settings/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("System Configuration")).not.toBeInTheDocument();
  });

  it("switches side-nav sections without leaving old sections underneath", async () => {
    await renderConfigPage();

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

  it("consolidates backend defaults into a single Agent backends section", async () => {
    await renderConfigPage();

    expect(
      screen.getByRole("tab", { name: "Agent backends" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Agent defaults" }),
    ).not.toBeInTheDocument();

    selectSettingsTab("Agent backends");
    expect(
      screen.getByRole("heading", { name: /Agent backends/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Default backend")).toBeVisible();
    expect(screen.getByText("Claude model")).toBeVisible();
    expect(screen.getByText("Codex model")).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Codex fast mode" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("tab", { name: "Agent backends" }).className,
    ).toContain("max-768:min-h-[var(--touch-target-min)]");
    expect(
      screen
        .getByRole("heading", { name: /Agent backends/i })
        .closest("section")?.parentElement?.className,
    ).toContain(
      "max-768:pb-[calc(var(--spacing-3xl)+var(--touch-target-min))]",
    );
  });

  it("saves independent backend edits while preserving untouched raw settings", async () => {
    api.json("GET", "/api/config", {
      config: {
        ...fullConfigData.config,
        agentBackends: {
          ...fullConfigData.config.agentBackends,
          codex: {
            ...fullConfigData.config.agentBackends.codex,
            model: "gpt-5.4-mini",
          },
        },
      },
      raw: {
        baseDir: "/home/user/projects",
        branchPrefix: "feature",
        agentBackends: { codex: { model: "gpt-5.4-mini" } },
      },
    });
    await renderConfigPage();
    selectSettingsTab("Agent backends");

    const backendField = screen
      .getByText("Backend")
      .closest('[data-field="defaultAgentBackend"]')!;
    fireEvent.click(
      [...backendField.querySelectorAll("button")].find(
        (button) => button.textContent === "codex",
      )!,
    );
    const claudeModelField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    fireEvent.click(
      [...claudeModelField.querySelectorAll("button")].find(
        (button) => button.textContent === "Sonnet",
      )!,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Codex fast mode" }));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig()).toEqual({
      baseDir: "/home/user/projects",
      branchPrefix: "feature",
      defaultAgentBackend: "codex",
      agentBackends: {
        claude: { model: "sonnet" },
        codex: { fastMode: true, model: "gpt-5.4-mini" },
      },
    });
  });

  it("reverts unsaved backend profile edits", async () => {
    await renderConfigPage();
    selectSettingsTab("Agent backends");

    const claudeModelField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    fireEvent.click(
      [...claudeModelField.querySelectorAll("button")].find(
        (button) => button.textContent === "Sonnet",
      )!,
    );
    expect(screen.getByText(/unsaved change/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    expect(screen.getByText("All changes saved")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Save changes/i }),
    ).toBeDisabled();
  });

  it("blocks save for an invalid backend timeout and Revert clears the local error", async () => {
    await renderConfigPage();
    selectSettingsTab("Agent backends");

    const backendField = screen
      .getByText("Backend")
      .closest('[data-field="defaultAgentBackend"]')!;
    fireEvent.click(
      [...backendField.querySelectorAll("button")].find(
        (button) => button.textContent === "codex",
      )!,
    );
    const timeout = screen.getByRole("textbox", { name: "Claude timeout" });
    fireEvent.change(timeout, { target: { value: "invalid" } });

    expect(screen.getByText(/1 invalid field/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Save changes/i }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(api.requestsTo("PUT", "/api/config")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Revert/i }));
    expect(timeout).toHaveValue("60");
    expect(timeout).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/invalid field/i)).not.toBeInTheDocument();
  });

  it("saves global validation settings as a sparse nested block", async () => {
    await renderConfigPage();
    selectSettingsTab("Limits & timeouts");

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Validation capacity",
      }),
      { target: { value: "4" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Validation timeout" }),
      { target: { value: "15" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig()).toEqual({
      baseDir: "/home/user/projects",
      validation: {
        concurrencyLimit: 4,
        defaultTimeoutMs: 900_000,
      },
    });
  });

  it("reverts validation edits and clears validation errors", async () => {
    await renderConfigPage();
    selectSettingsTab("Limits & timeouts");

    const concurrencyLimit = screen.getByRole("textbox", {
      name: "Validation capacity",
    });
    const defaultTimeout = screen.getByRole("textbox", {
      name: "Validation timeout",
    });
    fireEvent.change(concurrencyLimit, { target: { value: "4" } });
    fireEvent.change(defaultTimeout, { target: { value: "0" } });

    expect(screen.getByText(/1 invalid field/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Save changes/i }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    expect(concurrencyLimit).toHaveValue("8");
    expect(defaultTimeout).toHaveValue("10");
    expect(defaultTimeout).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/invalid field/i)).not.toBeInTheDocument();
  });

  it("renders config section headers as static chrome instead of expandable controls", async () => {
    await renderConfigPage();

    expect(
      screen.queryByRole("button", { name: /Workspace/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Workspace$/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Infrastructure/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Infrastructure$/i)).toBeVisible();
  });

  it("renders workflow defaults directly at the page top level", async () => {
    const { container } = await renderConfigPage();
    selectSettingsTab(/Workflow defaults/i);

    expect(
      screen.queryByRole("button", { name: /Workflow Defaults/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Implementer/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Implementer$/i)).toBeVisible();
    expect(container.querySelectorAll("[data-subsection]")).toHaveLength(11);
  });

  it("renders all eleven workflow default blocks at the page top level", async () => {
    await renderConfigPage();
    expandWorkflowDefaults();

    const expected = [
      "Implementer",
      "Collaboration",
      "Context validator",
      "Script validator",
      "Agent validation",
      "Lane-merge validation",
      "Ask user questions",
      "Iteration policy",
      "Circuit breaker",
      "Plan repair",
      "Mutability",
    ];
    for (const title of expected) {
      expect(screen.getByText(new RegExp(`^${title}$`, "i"))).toBeVisible();
    }
  });

  it("renders every workflow block as a sub-section", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    expect(container.querySelectorAll("[data-subsection]")).toHaveLength(11);
  });

  it("shows [DEFAULT] on every sub-section when all fields match seeded defaults", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const subs = container.querySelectorAll("[data-subsection]");
    for (const el of subs) {
      expect(el.textContent).toContain("DEFAULT");
      expect(el.textContent).not.toContain("MODIFIED");
    }
  });

  it("shows [MODIFIED] on a sub-section whose block differs from seeded defaults", async () => {
    const customDefaults: WorkflowDefaults = {
      ...structuredClone(SEEDED_WORKFLOW_DEFAULTS),
      iterationPolicy: {
        maxIterations: 99,
        continuity: { enabled: true },
      },
    };
    api.json("GET", "/api/config", {
      config: { ...fullConfigData.config, workflowDefaults: customDefaults },
      raw: {
        ...fullConfigData.raw,
        workflowDefaults: { iterationPolicy: customDefaults.iterationPolicy },
      },
    });

    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const iteration = container.querySelector(
      '[data-subsection="iterationPolicy"]',
    )!;
    expect(iteration.textContent).toContain("MODIFIED");

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    )!;
    expect(implementer.textContent).toContain("DEFAULT");
    expect(implementer.textContent).not.toContain("MODIFIED");
  });

  it("never surfaces a 'disabled' kind in the Context validator sub-section", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const validator = container.querySelector(
      '[data-subsection="contextValidator"]',
    );
    expect(validator).toBeTruthy();
    // The word "disabled" must not appear as an option / pill in the sub-section.
    const texts = Array.from(validator!.querySelectorAll("button")).map((el) =>
      (el.textContent ?? "").trim().toLowerCase(),
    );
    expect(texts).not.toContain("disabled");
    // The `kind` discriminator must not leak either.
    expect(texts).not.toContain("use");
  });

  it("marks the Implementer sub-section [MODIFIED] after editing the model", async () => {
    const user = userEvent.setup();
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;
    expect(implementer.textContent).toContain("DEFAULT");

    // Edit implementer.model from "opus" → "sonnet" via the ModelSelector.
    await pickModel(user, implementer, "Sonnet");

    expect(implementer.textContent).toContain("MODIFIED");
  });

  it("switching the implementer model to Haiku does not crash and disables effort editing", async () => {
    const user = userEvent.setup();
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;

    await pickModel(user, implementer, "Haiku");

    expect(
      implementer.querySelector('[data-testid="model-selector-label"]')
        ?.textContent,
    ).toBe("Haiku");

    const effortTrigger = implementer.querySelector(
      '[data-testid="effort-selector-trigger"]',
    ) as HTMLButtonElement;
    expect(effortTrigger).toBeDisabled();
    expect(
      implementer.querySelector('[data-testid="effort-selector-label"]')
        ?.textContent,
    ).toBe("Unavailable");
  });

  it("save writes only the changed blocks (unchanged workflow-defaults blocks not written)", async () => {
    const user = userEvent.setup();
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const implementer = container.querySelector(
      '[data-subsection="implementer"]',
    ) as HTMLElement;

    await pickModel(user, implementer, "Sonnet");

    expect(implementer.textContent).toContain("MODIFIED");

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    const defaults = savedConfig().workflowDefaults;
    expect(defaults).toEqual({
      implementer: expect.objectContaining({
        agent: expect.objectContaining({ model: "sonnet" }),
      }),
    });
  });

  it("saves only the changed compaction field after editing the Compaction section", async () => {
    const { container } = await renderConfigPage();
    selectSettingsTab(/Compaction/i);

    const effortField = container.querySelector(
      '[data-field="compaction.effort"]',
    ) as HTMLElement;
    const highBtn = [...effortField.querySelectorAll("button")].find(
      (b) => b.textContent === "high",
    ) as HTMLButtonElement;
    fireEvent.click(highBtn);

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    fireEvent.click(saveBtn);

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().compaction).toEqual({ effort: "high" });
  });

  it("marks the Plan repair sub-section modified and saves the full block after disabling it", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const planRepair = container.querySelector(
      '[data-subsection="planRepair"]',
    ) as HTMLElement;
    expect(planRepair.textContent).toContain("DEFAULT");

    // The first switch in the block is the enabled toggle (on by default).
    const toggle = planRepair.querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(toggle);

    expect(planRepair.textContent).toContain("MODIFIED");

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().workflowDefaults).toEqual({
      planRepair: { enabled: false, maxAttemptsPerContext: 2 },
    });
  });

  it("marks the Script validator sub-section modified and saves only that block after selecting a command", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    ) as HTMLElement;
    expect(scriptValidator.textContent).toContain("DEFAULT");

    const input = scriptValidator.querySelector(
      'input[aria-label="Add script validator command"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typecheck" } });
    const addButton = Array.from(
      scriptValidator.querySelectorAll("button"),
    ).find((button) => button.textContent === "Add")!;
    fireEvent.click(addButton);

    expect(scriptValidator.textContent).toContain("MODIFIED");

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    fireEvent.click(saveBtn);

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    const defaults = savedConfig().workflowDefaults;
    expect(defaults).toEqual({
      scriptValidator: { commands: ["typecheck"] },
    });
  });

  it("marks Agent validation modified and saves only that block after a role selector edit", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const agentValidation = container.querySelector(
      '[data-subsection="agentValidation"]',
    ) as HTMLElement;
    expect(agentValidation.textContent).toContain("DEFAULT");

    const implementerField = agentValidation.querySelector(
      '[data-field="workflowDefaults.agentValidation.implementer"]',
    ) as HTMLElement;
    const onlyRadio = Array.from(
      implementerField.querySelectorAll('[role="radio"]'),
    ).find((el) => el.textContent === "Only") as HTMLElement;
    fireEvent.click(onlyRadio);

    expect(agentValidation.textContent).toContain("MODIFIED");

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().workflowDefaults).toEqual({
      agentValidation: {
        implementer: { mode: "only", commands: [] },
        contextValidator: { mode: "only", commands: [] },
      },
    });
  });

  it("marks Lane-merge validation modified and saves only that block after a strategy edit", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const laneMerge = container.querySelector(
      '[data-subsection="laneMergeValidation"]',
    ) as HTMLElement;
    expect(laneMerge.textContent).toContain("DEFAULT");

    const strategyField = laneMerge.querySelector(
      '[data-field="workflowDefaults.laneMergeValidation.strategy"]',
    ) as HTMLElement;
    const everyMerge = Array.from(
      strategyField.querySelectorAll("button"),
    ).find(
      (el) => (el.textContent ?? "").trim() === "every-merge",
    ) as HTMLElement;
    fireEvent.click(everyMerge);

    expect(laneMerge.textContent).toContain("MODIFIED");

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().workflowDefaults).toEqual({
      laneMergeValidation: {
        strategy: "every-merge",
        commands: { mode: "project" },
      },
    });
  });
});
