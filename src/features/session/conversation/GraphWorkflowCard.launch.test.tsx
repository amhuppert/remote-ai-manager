// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GraphWorkflowCard from "@/features/session/conversation/GraphWorkflowCard";
import type {
  ParameterDeclaration,
  WorkflowDefinitionRecord,
} from "@/lib/workflows/schemas";

// The connected launcher is driven entirely through the HTTP boundary
// (definition list, per-definition detail, start mutation). Stubbing
// `global.fetch` exercises the real query/mutation wiring and the real
// form-vs-one-click decision without mocking any internal module.

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderCard(): void {
  render(
    <QueryClientProvider client={makeClient()}>
      <GraphWorkflowCard
        projectName="proj-1"
        sessionName="sess-1"
        execution={null}
        isFinished={false}
      />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function definitionRecord(
  id: string,
  name: string,
  parameters: ParameterDeclaration[],
): WorkflowDefinitionRecord {
  return {
    id,
    name,
    description: null,
    schemaVersion: 1,
    revision: 1,
    definition: {
      schemaVersion: 1,
      workflowConfig: {},
      charter: {
        mission: "Ship the feature",
        sourcesOfTruth: [
          {
            rank: 1,
            id: "src-1",
            label: "Spec",
            type: "spec",
            locator: ".kiro/specs/x",
            description: "The spec",
            accessPolicy: "worktree-relative",
          },
        ],
      },
      parameters,
      prerequisites: [],
      executionContexts: [],
      tasks: [],
      edges: [],
    },
    layout: {
      workflowId: id,
      contextPositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const LIST_URL = "/api/projects/proj-1/workflows";
const START_URL = "/api/projects/proj-1/sessions/sess-1/graph-workflow";
function detailUrl(id: string): string {
  return `/api/projects/proj-1/workflows/${id}`;
}

interface RouteConfig {
  zeroInput: WorkflowDefinitionRecord;
  parameterized: WorkflowDefinitionRecord;
  startResponse?: () => Response;
}

// Routes fetch by URL/method, returning the GET shapes the queries expect
// (`{ item, resolved }` for detail). The start handler is configurable so a
// test can simulate a 400 input rejection.
function installRouter(config: RouteConfig): {
  fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
  startBodies: unknown[];
} {
  const startBodies: unknown[] = [];
  const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === START_URL && method === "POST") {
      startBodies.push(JSON.parse(String(init?.body)));
      return config.startResponse
        ? config.startResponse()
        : jsonResponse({ execution: { id: "exec-1" } }, 202);
    }

    if (url === LIST_URL) {
      return jsonResponse({
        items: [config.zeroInput, config.parameterized].map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          revision: d.revision,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      });
    }

    const resolved = {
      schemaVersion: 1,
      executionContexts: [],
      tasks: [],
      edges: [],
    };
    if (url === detailUrl(config.zeroInput.id)) {
      return jsonResponse({ item: config.zeroInput, resolved });
    }
    if (url === detailUrl(config.parameterized.id)) {
      return jsonResponse({ item: config.parameterized, resolved });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, startBodies };
}

const PARAMS: ParameterDeclaration[] = [
  { type: "string", name: "feature", label: "Feature name", required: true },
];

describe("GraphWorkflowCard launcher integration", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps one-click launch for a zero-input definition and sends no parameters", async () => {
    const user = userEvent.setup();
    const { startBodies } = installRouter({
      zeroInput: definitionRecord("def-zero", "Zero Input", []),
      parameterized: definitionRecord("def-params", "Parameterized", PARAMS),
    });

    renderCard();

    await screen.findByRole("option", { name: "Zero Input" });
    await user.selectOptions(screen.getByRole("combobox"), "def-zero");

    // Selecting the definition loads its detail; wait for the parameter check
    // to settle before clicking.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run workflow/i }),
      ).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]).toEqual({ definitionId: "def-zero" });
    // No launch form modal for a zero-input definition.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the launch form for a parameterized definition and starts with the collected values", async () => {
    const user = userEvent.setup();
    const { startBodies } = installRouter({
      zeroInput: definitionRecord("def-zero", "Zero Input", []),
      parameterized: definitionRecord("def-params", "Parameterized", PARAMS),
    });

    renderCard();

    await screen.findByRole("option", { name: "Parameterized" });
    await user.selectOptions(screen.getByRole("combobox"), "def-params");

    // Wait until the selected definition's parameters have loaded.
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toHaveValue("def-params");
    });

    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    const dialog = await screen.findByRole("dialog");
    expect(startBodies).toHaveLength(0);

    const featureInput = within(dialog).getByLabelText("Feature name");
    await user.type(featureInput, "Search box");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]).toEqual({
      definitionId: "def-params",
      parameters: { feature: "Search box" },
    });
  });

  it("surfaces a 400 input rejection inside the launch form", async () => {
    const user = userEvent.setup();
    installRouter({
      zeroInput: definitionRecord("def-zero", "Zero Input", []),
      parameterized: definitionRecord("def-params", "Parameterized", PARAMS),
      startResponse: () =>
        jsonResponse(
          { error: 'Parameter "feature" is required but was not supplied' },
          400,
        ),
    });

    renderCard();

    await screen.findByRole("option", { name: "Parameterized" });
    await user.selectOptions(screen.getByRole("combobox"), "def-params");
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toHaveValue("def-params");
    });

    await user.click(screen.getByRole("button", { name: /run workflow/i }));
    const dialog = await screen.findByRole("dialog");

    // Submit a value the engine (simulated) rejects.
    await user.type(within(dialog).getByLabelText("Feature name"), "x");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    expect(
      await within(dialog).findByText(
        'Parameter "feature" is required but was not supplied',
      ),
    ).toBeInTheDocument();
    // The modal stays open so the author can correct the input.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
