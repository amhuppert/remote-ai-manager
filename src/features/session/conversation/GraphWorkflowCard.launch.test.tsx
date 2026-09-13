// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GraphWorkflowCard from "@/features/session/conversation/GraphWorkflowCard";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
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

// jsdom lacks the layout/pointer APIs Radix Select drives the listbox with;
// stub them so the workflow selector (now a Radix Select) opens under userEvent.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};

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
      await screen.findByRole("combobox", { name: /select a workflow/i }),
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
      definitionRevision: 1,
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
      await screen.findByRole("combobox", { name: /select a workflow/i }),
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
      definitionRevision: 1,
      tier: "global",
      parameters: { feature: "Search box" },
    });
  });

  it("selects the exact tier when global and project templates share an id", async () => {
    const user = userEvent.setup();
    const { startBodies } = installRouter({
      zeroInput: templateItem(
        "shared-definition",
        "Global shared workflow",
        [],
        "global",
      ),
      parameterized: templateItem(
        "shared-definition",
        "Project parameterized workflow",
        PARAMS,
        "project",
      ),
    });

    renderCard();
    await user.click(
      await screen.findByRole("combobox", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: /Project parameterized workflow/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Feature name"), "Shared ID");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]).toEqual({
      definitionId: "shared-definition",
      definitionRevision: 1,
      tier: "project",
      parameters: { feature: "Shared ID" },
    });
  });

  it("surfaces a parked zero-input launch with its recovery instruction", async () => {
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
          {
            error: "Workflow execution exec-parked was parked",
            code: "definition_approval_required",
            executionId: "exec-parked",
            instruction: "Approve definition exec-parked to continue.",
          },
          409,
        ),
    });
    renderCard();

    await user.click(
      await screen.findByRole("combobox", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Zero Input/i }),
    );
    await user.click(screen.getByRole("button", { name: /run workflow/i }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Approve definition exec-parked to continue.",
    );
    expect(
      within(status).getByRole("link", { name: /open workflow monitor/i }),
    ).toHaveAttribute("href", "/projects/proj-1/sess-1/workflow");
  });

  it("surfaces a parked parameterized launch after closing its form", async () => {
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
          {
            error: "Workflow execution exec-parked was parked",
            code: "definition_approval_required",
            executionId: "exec-parked",
            instruction: "Approve definition exec-parked to continue.",
          },
          409,
        ),
    });
    renderCard();

    await user.click(
      await screen.findByRole("combobox", { name: /select a workflow/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Parameterized/i }),
    );
    await user.click(screen.getByRole("button", { name: /run workflow/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Feature name"), "Search");
    await user.click(within(dialog).getByRole("button", { name: /^launch$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Approve definition exec-parked to continue.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
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
      await screen.findByRole("combobox", { name: /select a workflow/i }),
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
