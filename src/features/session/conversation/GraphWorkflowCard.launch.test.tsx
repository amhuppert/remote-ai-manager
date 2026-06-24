// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GraphWorkflowCard from "@/features/session/conversation/GraphWorkflowCard";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import type {
  TemplateLibraryItem,
  TemplateTier,
} from "@/lib/workflow-graph/template-library-service";

// The connected launcher is driven entirely through the HTTP boundary
// (cross-tier template list + start mutation). Stubbing `global.fetch`
// exercises the real query/mutation wiring and the real form-vs-one-click
// decision without mocking any internal module. Each cross-tier list item
// already carries its parameters, so there is no per-definition detail fetch.

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

function templateItem(
  id: string,
  name: string,
  parameters: ParameterDeclaration[],
  tier: TemplateTier,
): TemplateLibraryItem {
  return {
    tier,
    id,
    name,
    description: null,
    revision: 1,
    parameters,
    prerequisites: [],
  };
}

const LIST_URL = "/api/projects/proj-1/workflow-templates";
const START_URL = "/api/projects/proj-1/sessions/sess-1/graph-workflow";

interface RouteConfig {
  zeroInput: TemplateLibraryItem;
  parameterized: TemplateLibraryItem;
  startResponse?: () => Response;
}

// Routes fetch by URL/method, returning the cross-tier list shape the launcher
// query expects (`{ items }`). The start handler is configurable so a test can
// simulate a 400 input rejection.
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
      return jsonResponse({ items: [config.zeroInput, config.parameterized] });
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

  it("keeps one-click launch for a zero-input project template and sends only the tier", async () => {
    const user = userEvent.setup();
    const { startBodies } = installRouter({
      zeroInput: templateItem("def-zero", "Zero Input", [], "project"),
      parameterized: templateItem(
        "def-params",
        "Parameterized",
        PARAMS,
        "global",
      ),
    });

    renderCard();

    // Open the dropdown, then pick the option (labelled by its tier badge + name).
    await user.click(
      await screen.findByRole("button", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Zero Input/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run workflow/i }),
      ).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]).toEqual({
      definitionId: "def-zero",
      tier: "project",
    });
    // No launch form modal for a zero-input definition.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the launch form for a parameterized global template and starts with the collected values + tier", async () => {
    const user = userEvent.setup();
    const { startBodies } = installRouter({
      zeroInput: templateItem("def-zero", "Zero Input", [], "project"),
      parameterized: templateItem(
        "def-params",
        "Parameterized",
        PARAMS,
        "global",
      ),
    });

    renderCard();

    await user.click(
      await screen.findByRole("button", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Parameterized/i }),
    );

    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    const dialog = await screen.findByRole("dialog");
    expect(startBodies).toHaveLength(0);

    const featureInput = within(dialog).getByLabelText("Feature name");
    await user.type(featureInput, "Search box");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]).toEqual({
      definitionId: "def-params",
      tier: "global",
      parameters: { feature: "Search box" },
    });
  });

  it("surfaces a 400 input rejection inside the launch form", async () => {
    const user = userEvent.setup();
    installRouter({
      zeroInput: templateItem("def-zero", "Zero Input", [], "project"),
      parameterized: templateItem(
        "def-params",
        "Parameterized",
        PARAMS,
        "global",
      ),
      startResponse: () =>
        jsonResponse(
          { error: 'Parameter "feature" is required but was not supplied' },
          400,
        ),
    });

    renderCard();

    await user.click(
      await screen.findByRole("button", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Parameterized/i }),
    );
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
