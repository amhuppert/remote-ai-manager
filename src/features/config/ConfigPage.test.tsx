// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

/** Open the given container's catalog model select and pick a visible option. */
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
    .getAllByRole("option")
    .find((o) => (o.textContent ?? "").startsWith(labelPrefix));
  expect(option, `no model option "${labelPrefix}"`).toBeTruthy();
  await user.click(option!);
}
import type { GlobalConfig } from "@/lib/config/schemas";
import type { RawGlobalConfig } from "@/lib/config/schemas";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import ConfigPage from "./ConfigPage";

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
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: 3_600_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: null,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
    maxConcurrentQueries: 3,
    validation: {
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    },
    ignorePatterns: ["node_modules"],
    tailscaleEnabled: false,
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
  api.json("GET", "/api/runs/active", []);
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

describe("ConfigPage", () => {
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
    expect(screen.getByText("Claude model selection")).toBeVisible();
    expect(screen.getByText("Codex model selection")).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "Agent backends" }).className,
    ).toContain("max-768:min-h-[var(--touch-target-min)]");
    expect(
      screen
        .getByRole("heading", { name: /Agent backends/i })
        .closest("section")?.parentElement?.className,
    ).toContain("max-768:pb-[calc(120px+env(safe-area-inset-bottom,0px))]");
  });

  it("saves independent backend edits while preserving untouched raw settings", async () => {
    api.json("GET", "/api/config", {
      config: {
        ...fullConfigData.config,
        agentBackends: {
          ...fullConfigData.config.agentBackends,
          codex: {
            ...fullConfigData.config.agentBackends.codex,
            modelSelection: {
              modelId: "gpt-5.4-mini",
              parameters: { reasoning: "high", fast: "false" },
            },
          },
        },
      },
      raw: {
        baseDir: "/home/user/projects",
        branchPrefix: "feature",
        agentBackends: {
          codex: {
            modelSelection: {
              modelId: "gpt-5.4-mini",
              parameters: { reasoning: "high", fast: "false" },
            },
          },
        },
      },
    });
    const user = userEvent.setup();
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
      .getByText("Claude model selection")
      .closest('[data-field="agentBackends.claude.modelSelection"]')!;
    await pickModel(user, claudeModelField as HTMLElement, "Sonnet");
    const codexModelField = screen
      .getByText("Codex model selection")
      .closest('[data-field="agentBackends.codex.modelSelection"]')!;
    fireEvent.click(
      codexModelField.querySelector('[role="switch"][aria-label="Fast mode"]')!,
    );
    fireEvent.click(
      [...codexModelField.querySelectorAll("button")].find(
        (button) => button.textContent === "Apply",
      )!,
    );
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig()).toEqual({
      baseDir: "/home/user/projects",
      branchPrefix: "feature",
      defaultAgentBackend: "codex",
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "high" },
          },
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4-mini",
            parameters: { reasoning: "high", fast: "true" },
          },
        },
      },
    });
  });

  it("reverts unsaved backend profile edits", async () => {
    const user = userEvent.setup();
    await renderConfigPage();
    selectSettingsTab("Agent backends");

    const claudeModelField = screen
      .getByText("Claude model selection")
      .closest('[data-field="agentBackends.claude.modelSelection"]')!;
    await pickModel(user, claudeModelField as HTMLElement, "Sonnet");
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

  it("saves the checkpoint backend, model, and reasoning directly from the controls", async () => {
    const naming = {
      enabled: true,
      backend: "claude" as const,
      modelSelection: { modelId: "haiku", parameters: {} },
    };
    seedConfigRoutes({
      config: { ...fullConfigData.config, conversationNaming: naming },
      raw: { ...fullConfigData.raw, conversationNaming: naming },
    });
    const user = userEvent.setup();
    const { container } = await renderConfigPage();
    selectSettingsTab(/Compaction/i);
    const backend = container.querySelector(
      '[data-field="compaction.backend"]',
    ) as HTMLElement;
    await user.click(
      await within(backend).findByRole("button", { name: "codex" }),
    );
    const selection = container.querySelector(
      '[data-field="compaction.conversationModelSelection"]',
    ) as HTMLElement;
    await pickModel(user, selection, "GPT-5.4 Mini");
    await user.click(
      within(selection).getByRole("combobox", { name: "Reasoning" }),
    );
    await user.click(screen.getByRole("option", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: /Save Changes/i }));
    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().conversationNaming?.modelSelection).toEqual(
      naming.modelSelection,
    );
    expect(savedConfig().compaction).toMatchObject({
      backend: "codex",
      conversationModelSelection: {
        modelId: "gpt-5.4-mini",
        parameters: { reasoning: "low", fast: "false" },
      },
    });
  });

  it("saves only the changed compaction field after editing the Compaction section", async () => {
    const user = userEvent.setup();
    const { container } = await renderConfigPage();
    selectSettingsTab(/Compaction/i);

    const conversationSelection = container.querySelector(
      '[data-field="compaction.conversationModelSelection"]',
    ) as HTMLElement;
    await pickModel(user, conversationSelection, "Opus 5");

    const saveBtn = screen.getByRole("button", {
      name: /Save Changes/i,
    }) as HTMLButtonElement;
    fireEvent.click(saveBtn);

    await vi.waitFor(() =>
      expect(api.requestsTo("PUT", "/api/config")).toHaveLength(1),
    );
    expect(savedConfig().compaction).toEqual({
      conversationModelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
  });
});
