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
}

/** The last full-config payload PUT to /api/config, parsed from the wire. */
function savedConfig(): GlobalConfig {
  const puts = api.requestsTo("PUT", "/api/config");
  expect(puts).toHaveLength(1);
  return puts[0]?.jsonBody as GlobalConfig;
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

    expect(
      screen.getByRole("tablist", { name: "Settings" }),
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

  it("exposes the settings nav as a vertical Radix tablist", async () => {
    await renderConfigPage();

    // Radix promotes the <nav> to role=tablist; aria-label is preserved.
    const tablist = screen.getByRole("tablist", { name: "Settings" });
    expect(tablist).toHaveAttribute("data-orientation", "vertical");
    expect(tablist.tagName).toBe("NAV");
  });

  it("wires the active section to a role=tabpanel", async () => {
    await renderConfigPage();

    const generalTab = screen.getByRole("tab", { name: /General/i });
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute(
      "aria-labelledby",
      generalTab.getAttribute("id"),
    );
    expect(
      screen.getByRole("heading", { name: /General settings/i }),
    ).toBeInTheDocument();
  });

  it("moves selection + DOM focus with ArrowDown and swaps the tabpanel", async () => {
    const user = userEvent.setup();
    await renderConfigPage();

    const generalTab = screen.getByRole("tab", { name: /General/i });
    generalTab.focus();
    expect(generalTab).toHaveFocus();

    await user.keyboard("{ArrowDown}");

    const defaultsTab = screen.getByRole("tab", { name: /Agent defaults/i });
    expect(defaultsTab).toHaveFocus();
    expect(defaultsTab).toHaveAttribute("aria-selected", "true");
    expect(generalTab).toHaveAttribute("aria-selected", "false");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute(
      "aria-labelledby",
      defaultsTab.getAttribute("id"),
    );
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
    expect(container.querySelectorAll("[data-subsection]")).toHaveLength(8);
  });

  it("renders all eight workflow default blocks at the page top level", async () => {
    await renderConfigPage();
    expandWorkflowDefaults();

    const expected = [
      "Implementer",
      "Collaboration",
      "Context validator",
      "Script validator",
      "Ask user questions",
      "Iteration policy",
      "Circuit breaker",
      "Mutability",
    ];
    for (const title of expected) {
      expect(screen.getByText(new RegExp(`^${title}$`, "i"))).toBeVisible();
    }
  });

  it("renders every workflow block as a sub-section", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    expect(container.querySelectorAll("[data-subsection]")).toHaveLength(8);
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
      implementer: expect.objectContaining({ model: "sonnet" }),
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

  it("marks the Script validator sub-section modified and saves only that block after enabling it", async () => {
    const { container } = await renderConfigPage();
    expandWorkflowDefaults();

    const scriptValidator = container.querySelector(
      '[data-subsection="scriptValidator"]',
    ) as HTMLElement;
    expect(scriptValidator.textContent).toContain("DEFAULT");

    const toggle = scriptValidator.querySelector(
      '[role="switch"]',
    ) as HTMLElement;
    fireEvent.click(toggle);

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
      scriptValidator: { enabled: true },
    });
  });
});
