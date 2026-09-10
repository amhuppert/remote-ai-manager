// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import SpawnCard, { ValidSpawnCard, eligibleTargetBranches } from "./SpawnCard";
import { validateProposal } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal, SpawnResult } from "@/lib/chat-spawning/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import {
  getStaticBackendModelCatalog,
  listBackendCatalogEntries,
  type BackendValueMap,
} from "@/lib/agent-backends/catalog";
import { loadGeneratedCursorModelCatalog } from "@/lib/agent-backends/cursor/model-catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import type { BackendModelCatalog } from "@/lib/agent-backends/schemas";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

function projectModelOptions(defaults: BackendSelectionDefaultsById) {
  const catalogs: BackendValueMap<BackendModelCatalog> = {
    claude: getStaticBackendModelCatalog("claude"),
    codex: getStaticBackendModelCatalog("codex", defaults.codex),
    cursor: loadGeneratedCursorModelCatalog(),
  };
  return (["claude", "codex", "cursor"] as const).map((backend) => ({
    backend,
    models: [],
    defaultModelId: defaults[backend].modelId,
    source: "catalog" as const,
    modelCatalog: catalogs[backend],
    defaultSelection: defaults[backend],
    diagnostics: [],
  }));
}

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

function renderCard(
  ui: React.ReactElement,
  backendDefaults: BackendSelectionDefaultsById = BACKEND_DEFAULTS,
  seedModelOptions = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (seedModelOptions) {
    client.setQueryData(
      backendCatalogKeys.projectModelOptions("repo"),
      projectModelOptions(backendDefaults),
    );
  }
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

let fetchFixture: FetchFixture | undefined;

function asProposal(candidate: unknown): SpawnProposal {
  const validation = validateProposal(candidate);
  if (validation.kind !== "valid") throw new Error("expected a valid proposal");
  return validation.proposal;
}

const single = asProposal({
  sessions: [{ name: "alpha", agent: "claude", mode: "normal" }],
});

const multi = asProposal({
  sessions: [
    { name: "alpha", agent: "claude", mode: "normal" },
    { name: "beta", agent: "codex", mode: "optimistic" },
  ],
});

const dual = asProposal({
  sessions: [{ name: "race", agent: "dual", mode: "normal" }],
});

function renderValid(
  proposal: SpawnProposal,
  overrides: Partial<React.ComponentProps<typeof ValidSpawnCard>> = {},
  seedModelOptions = true,
) {
  const backendDefaults = overrides.backendDefaults ?? BACKEND_DEFAULTS;
  return renderCard(
    <ValidSpawnCard
      proposal={proposal}
      projectName="repo"
      conversationId="plc-1"
      spawnedStatuses={undefined}
      branchPrefix="csm"
      targetOptions={["main"]}
      {...overrides}
      backendDefaults={backendDefaults}
    />,
    backendDefaults,
    seedModelOptions,
  );
}

afterEach(() => {
  fetchFixture?.restore();
  fetchFixture = undefined;
  cleanup();
  vi.unstubAllGlobals();
});

describe("eligibleTargetBranches", () => {
  it("includes non-archived session branches and excludes archived ones", () => {
    const branches = eligibleTargetBranches([
      { branchName: "csm/live", archived: false },
      { branchName: "csm/old", archived: true },
      { branchName: "csm/also-live", archived: false },
    ]);
    expect(branches).toEqual(["csm/live", "csm/also-live"]);
  });

  it("returns an empty list when every session is archived", () => {
    const branches = eligibleTargetBranches([
      { branchName: "csm/old", archived: true },
    ]);
    expect(branches).toEqual([]);
  });
});

describe("SpawnCard", () => {
  it("renders a row with name, the name-derived <prefix>/<slug> branch preview, and target", () => {
    renderValid(single);
    expect(screen.getByText("alpha")).toBeTruthy();
    // Branch is derived from the name with the resolved prefix — never proposed.
    expect(screen.getByText("csm/alpha")).toBeTruthy();
    expect(screen.getByText("auto")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("lets an editable proposed-session title use the remaining row width", () => {
    const longTitle = asProposal({
      sessions: [
        {
          name: "VOGUE-4982 Fix location table sorting",
          agent: "claude",
          mode: "optimistic",
        },
      ],
    });
    renderValid(longTitle);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", {
      name: "Session 1 name",
    });

    expect(input).toHaveClass("min-w-0", "flex-1");
    expect(input).not.toHaveClass("w-[200px]");
  });

  it("exposes always-editable agent and mode segmented controls", () => {
    renderValid(single);
    expect(
      screen.getByRole("radiogroup", { name: "Session 1 agent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Session 1 mode" }),
    ).toBeTruthy();
  });

  it("tints the Codex agent segment violet (Codex backend identity)", () => {
    renderValid(single);
    const codex = screen.getByRole("radio", { name: "Codex" });
    expect(codex.className).toContain("data-[state=checked]:bg-violet-glow");
    const claude = screen.getByRole("radio", { name: "Claude" });
    expect(claude.className).toContain("data-[state=checked]:bg-cyan-glow");
  });

  it("shows catalog-driven model and parameter controls for a single-backend agent", () => {
    renderValid(single);
    expect(screen.getByTestId("model-selector-trigger")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Effort" })).toBeTruthy();
  });

  it("shows and submits a custom configured Codex model", async () => {
    const api = installFetchFixture();
    fetchFixture = api;
    api.json("GET", "/api/voice/health", { available: false });
    const spawnPath = "/api/projects/repo/conversations/plc-1/spawn";
    api.json("POST", spawnPath, { created: [], failed: [] });
    const codexOnly = asProposal({
      sessions: [{ name: "beta", agent: "codex", mode: "normal" }],
    });

    renderValid(codexOnly, {
      backendDefaults: {
        claude: { modelId: "sonnet", parameters: { effort: "medium" } },
        codex: {
          modelId: "custom-codex-model",
          parameters: { reasoning: "ultra", fast: "false" },
        },
        cursor: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
      },
    });

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "custom-codex-model",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() =>
      expect(api.requestsTo("POST", spawnPath)).toHaveLength(1),
    );
    expect(api.requestsTo("POST", spawnPath)[0]?.jsonBody).toMatchObject({
      sessions: [
        {
          agent: "codex",
          modelSelection: {
            modelId: "custom-codex-model",
            parameters: { reasoning: "ultra", fast: "false" },
          },
        },
      ],
    });
  });

  it("hides model controls for a dual agent (both run defaults)", () => {
    renderValid(dual);
    expect(screen.queryByTestId("model-selector-trigger")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Reasoning" })).toBeNull();
  });

  it("labels Create with the included count (single)", () => {
    renderValid(single);
    expect(
      screen.getByRole("button", { name: "Create 1 session" }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 1 selected")).toBeTruthy();
  });

  it("labels Create with the included count (multi)", () => {
    renderValid(multi);
    expect(
      screen.getByRole("button", { name: "Create 2 sessions" }),
    ).toBeTruthy();
  });

  it("excluding a session lowers the count; excluding all disables Create", () => {
    renderValid(multi);
    fireEvent.click(
      screen.getByRole("switch", { name: "Create session alpha" }),
    );
    expect(
      screen.getByRole("button", { name: "Create 1 session" }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 2 selected")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "Create session beta" }),
    );
    const create = screen.getByRole("button", {
      name: "Create 0 sessions",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it("renders a non-actionable invalid state with no Create", () => {
    const invalid = validateProposal({ sessions: [] });
    renderCard(
      <SpawnCard
        validation={invalid}
        projectName="repo"
        conversationId="plc-1"
        backendDefaults={BACKEND_DEFAULTS}
      />,
    );
    expect(screen.getByText("Invalid spawn proposal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });

  it("opens an edit pass and submits the edited values (reviewed == created)", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "renamed",
          sessionName: "renamed",
          branchName: "csm/renamed",
          initialPromptQueued: false,
        },
      ],
      failed: [],
    };
    const api = installFetchFixture();
    fetchFixture = api;
    api.json("GET", "/api/voice/health", { available: false });
    const spawnPath = "/api/projects/repo/conversations/plc-1/spawn";
    api.json("POST", spawnPath, result);

    renderValid(single);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText(
      "Session 1 name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() =>
      expect(api.requestsTo("POST", spawnPath)).toHaveLength(1),
    );
    const sentBody = api.requestsTo("POST", spawnPath)[0]?.jsonBody as {
      sessions: Array<{ name: string; branch?: string }>;
    };
    expect(sentBody.sessions[0]!.name).toBe("renamed");
    // The branch is never part of the submitted payload — the server derives it.
    expect(sentBody.sessions[0]!.branch).toBeUndefined();

    // Post-create the card surfaces the result instead of the Create control.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Create/ })).toBeNull(),
    );
  });

  it("submits only the included sessions", async () => {
    const result: SpawnResult = { created: [], failed: [] };
    const captured: { body?: string } = {};
    // Counted by URL rather than by total calls: the card also issues its own
    // reads (voice health, the project's model options), and a total-call
    // assertion would fail whenever a card gains one.
    const spawnRequests: string[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/spawn")) {
        spawnRequests.push(url);
        captured.body = init.body as string;
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    renderValid(multi);
    fireEvent.click(
      screen.getByRole("switch", { name: "Create session alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() => expect(spawnRequests).toHaveLength(1));
    const sentBody = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ name: string }>;
    };
    expect(sentBody.sessions).toHaveLength(1);
    expect(sentBody.sessions[0]!.name).toBe("beta");
  });

  it("submits every row's current canonical reference document from the card action", async () => {
    const captured: { body?: string } = {};
    fetchFixture = installFetchFixture();
    fetchFixture.json("POST", "/api/live-references", { results: [] });
    fetchFixture.reply(
      "POST",
      "/api/projects/repo/conversations/plc-1/spawn",
      (request) => {
        captured.body = JSON.stringify(request.jsonBody);
        return { json: { created: [], failed: [] } };
      },
    );
    const conversationRef =
      '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
      'scope="session" ' +
      'session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
      'conversation-id="conv-1" conversation-name="Refactor parser" ' +
      'backend="claude" backend-ref="sess-abc" debug-log-path="" ' +
      'status="running" last-activity-at="2026-06-01T12:00:00Z" ' +
      'compact-status="none" read-command="cctl conversation read conv-1 --outline" />';
    const messageRef =
      '<message-ref project-name="my-app" session-name="main" ' +
      'conversation-id="conv-2" conversation-name="Fix flake" ' +
      'message-index="7" role="assistant" compacted="false" ' +
      'read-command="cctl conversation read conv-2 --message 7" />';
    const paste = (element: HTMLElement, text: string) =>
      fireEvent.paste(element, {
        clipboardData: {
          items: [],
          files: [],
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? text : ""),
        },
      });

    const { container } = renderValid(multi);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editors = container.querySelectorAll(".ProseMirror");
    paste(editors[0] as HTMLElement, conversationRef);
    paste(editors[1] as HTMLElement, messageRef);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Create 2 sessions" }));

    await waitFor(() => expect(captured.body).toBeDefined());
    const sent = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ initialPrompt?: string }>;
    };
    expect(sent.sessions[0]?.initialPrompt).toBe(conversationRef);
    expect(sent.sessions[1]?.initialPrompt).toBe(messageRef);
  });

  it("preserves inline and strip images through Done and Edit", async () => {
    URL.createObjectURL = vi.fn(() => "blob:spawn-image");
    URL.revokeObjectURL = vi.fn();
    const captured: { body?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured.body = init?.body as string;
        return Response.json({ created: [], failed: [] });
      }),
    );
    const { container } = renderValid(single);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = container.querySelector(".ProseMirror") as HTMLElement;
    const inline = new File(["inline"], "inline.png", { type: "image/png" });
    fireEvent.paste(editor, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: inline.type,
            getAsFile: () => inline,
          },
        ],
        files: [inline],
        types: [],
        getData: () => "",
      },
    });
    await waitFor(() =>
      expect(container.querySelector("[data-attachment-id]")).not.toBeNull(),
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const strip = new File(["strip"], "strip.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [strip] } });
    await waitFor(() => expect(screen.getByTitle("Remove image")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() => expect(captured.body).toBeDefined());
    const sent = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ initialPrompt?: string; images?: ImagePayload[] }>;
    };
    expect(sent.sessions[0]?.initialPrompt).toContain("[Image #1]");
    expect(sent.sessions[0]?.images).toEqual([
      expect.objectContaining({ inlineMarkerIndex: 1 }),
      expect.not.objectContaining({ inlineMarkerIndex: expect.anything() }),
    ]);
  });

  it("preserves proposal-provided references and image placement on first edit", async () => {
    URL.revokeObjectURL = vi.fn();
    const conversationRef =
      '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
      'scope="session" ' +
      'session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
      'conversation-id="conv-1" conversation-name="Refactor parser" ' +
      'backend="claude" backend-ref="sess-abc" debug-log-path="" ' +
      'status="running" last-activity-at="2026-06-01T12:00:00Z" ' +
      'compact-status="none" read-command="cctl conversation read conv-1 --outline" />';
    const messageRef = buildMessageRefXml({
      projectName: "my-app",
      sessionName: "main",
      conversationId: "conv-1",
      conversationName: "Refactor parser",
      messageIndex: 4,
      role: "assistant",
      timestamp: null,
      model: null,
      compaction: null,
    });
    const ticketRef = buildTicketRefXml({
      projectName: "my-app",
      ticketNumber: 7,
      title: "Preserve canonical prompt",
    });
    const extraTicketRef = buildTicketRefXml({
      projectName: "my-app",
      ticketNumber: 8,
      title: "Trigger first edit update",
    });
    const images: ImagePayload[] = [
      {
        attachmentId: "inline-1",
        mediaType: "image/png",
        base64Data: "aW5saW5l",
        inlineMarkerIndex: 1,
      },
      {
        attachmentId: "strip-1",
        mediaType: "image/png",
        base64Data: "c3RyaXA=",
      },
    ];
    const proposal = asProposal({
      sessions: [
        {
          name: "hydrated",
          agent: "claude",
          mode: "normal",
          initialPrompt: `${conversationRef}\n${messageRef}\n${ticketRef}\n[Image #1]`,
          images,
        },
      ],
    });
    const captured: { body?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured.body = init?.body as string;
        return Response.json({ created: [], failed: [] });
      }),
    );
    const { container } = renderValid(proposal);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = container.querySelector(".ProseMirror") as HTMLElement;
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? extraTicketRef : "",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() => expect(captured.body).toBeDefined());
    const sent = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ initialPrompt?: string; images?: ImagePayload[] }>;
    };
    expect(sent.sessions[0]?.initialPrompt).toContain(conversationRef);
    expect(sent.sessions[0]?.initialPrompt).toContain(messageRef);
    expect(sent.sessions[0]?.initialPrompt).toContain(ticketRef);
    expect(sent.sessions[0]?.initialPrompt).toContain(extraTicketRef);
    expect(sent.sessions[0]?.images).toEqual(images);
  });

  it("renders passive spawned-session status after creation without drive controls", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "alpha",
          sessionName: "alpha",
          branchName: "csm/alpha",
          initialPromptQueued: true,
        },
      ],
      failed: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    renderValid(single, {
      spawnedStatuses: [{ sessionName: "alpha", derivedStatus: "running" }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    // No control drives a spawned session beyond its first turn.
    expect(
      screen.queryByRole("button", { name: /Run|Stop|Merge|Prompt/ }),
    ).toBeNull();
  });
});

describe("SpawnCard project-scoped model options", () => {
  function serveProjectOptions(
    api: FetchFixture,
    models: readonly string[],
  ): void {
    const defaultOptions = projectModelOptions(BACKEND_DEFAULTS);
    const defaultModelId = models[0] ?? null;
    const cursorCatalog =
      defaultModelId === null
        ? null
        : {
            backend: "cursor" as const,
            defaultModelId,
            models: models.map((id) => ({
              id,
              label: id,
              aliases: [],
              parameters: [],
              variants: [
                {
                  selection: { modelId: id, parameters: {} },
                  label: id,
                  isDefault: id === defaultModelId,
                },
              ],
            })),
            provenance: { source: "test project catalog" },
          };
    api.json("GET", "/api/projects/repo/model-options", {
      backends: listBackendCatalogEntries().map((entry) =>
        entry.id === "cursor"
          ? {
              backend: entry.id,
              models: models.map((id) => ({
                id,
                label: id,
                description: "Configured for this project.",
                effortLevels: [],
              })),
              defaultModelId,
              source: "project",
              modelCatalog: cursorCatalog,
              defaultSelection:
                defaultModelId === null
                  ? null
                  : { modelId: defaultModelId, parameters: {} },
              diagnostics:
                defaultModelId === null
                  ? [
                      {
                        code: "complete_catalog_unavailable",
                        message: "No Cursor model variants are available.",
                      },
                    ]
                  : [],
            }
          : defaultOptions.find((option) => option.backend === entry.id)!,
      ),
    });
  }

  const cursorOnly = asProposal({
    sessions: [{ name: "gamma", agent: "cursor", mode: "normal" }],
  });

  it("builds a spawn row's model choices from the project's list", async () => {
    const api = installFetchFixture();
    fetchFixture = api;
    api.json("GET", "/api/voice/health", { available: false });
    serveProjectOptions(api, ["composer-1"]);

    renderValid(
      cursorOnly,
      {
        backendDefaults: {
          ...BACKEND_DEFAULTS,
          cursor: { modelId: "composer-1", parameters: {} },
        },
      },
      false,
    );

    await waitFor(() =>
      expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
        "composer-1",
      ),
    );
    expect(
      api.requestsTo("GET", "/api/projects/repo/model-options"),
    ).not.toHaveLength(0);
  });

  it("marks a configured model outside the project's list as an invalid selection", async () => {
    // The global profile still says composer-2.5, but this project lists only
    // composer-1 — the row must say so rather than offer a substitute.
    const api = installFetchFixture();
    fetchFixture = api;
    api.json("GET", "/api/voice/health", { available: false });
    serveProjectOptions(api, ["composer-1"]);

    renderValid(cursorOnly, {}, false);

    await waitFor(() =>
      expect(screen.getByTestId("model-selector-trigger")).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
  });
});
