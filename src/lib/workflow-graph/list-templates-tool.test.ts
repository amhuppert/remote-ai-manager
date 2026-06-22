import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateLibraryItem } from "./template-library-service";
import {
  registerListTemplatesTool,
  type ListTemplatesToolDeps,
} from "./list-templates-tool";

const TOOLS_KEY = "__test_list_templates_tools";
type ToolHandler = (args: unknown) => Promise<unknown>;

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[TOOLS_KEY]) {
    globalState[TOOLS_KEY] = new Map();
  }
  return globalState[TOOLS_KEY] as Map<
    string,
    { name: string; handler: ToolHandler }
  >;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }
  return tool.handler;
}

function registerTool(deps: ListTemplatesToolDeps): void {
  registerListTemplatesTool(
    createCapturingServer() as never,
    {
      projectPath: "/test",
      sessionName: "test-session",
    },
    deps,
  );
}

function makeItem(
  overrides: Partial<TemplateLibraryItem> &
    Pick<TemplateLibraryItem, "tier" | "id" | "name">,
): TemplateLibraryItem {
  return {
    description: null,
    revision: 1,
    parameters: [],
    prerequisites: [],
    ...overrides,
  };
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe("list_templates MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers only the list_templates tool", () => {
    const deps: ListTemplatesToolDeps = {
      listTemplates: vi.fn(async () => []),
    };

    registerTool(deps);

    expect([...getCapturedTools().keys()]).toEqual(["list_templates"]);
  });

  it("returns tier-tagged cross-tier items with identifier, name, parameters, and prerequisites", async () => {
    const items: TemplateLibraryItem[] = [
      makeItem({
        tier: "global",
        id: "wf-global",
        name: "Global Methodology",
        parameters: [
          {
            name: "env",
            label: "Environment",
            type: "enum",
            options: ["staging", "prod"],
            required: true,
          },
        ],
        prerequisites: [
          { kind: "path", path: ".kiro/specs", label: "specs dir" },
        ],
      }),
      makeItem({
        tier: "project",
        id: "wf-project",
        name: "Project Local",
      }),
    ];
    const listTemplates = vi.fn(async () => items);
    registerTool({ listTemplates });

    const result = (await getHandler("list_templates")({})) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(listTemplates).toHaveBeenCalledTimes(1);
    expect(listTemplates).toHaveBeenCalledWith("/test");

    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as Array<{
      tier: string;
      id: string;
      name: string;
      parameters: unknown[];
      prerequisites: unknown[];
    }>;
    expect(parsed).toHaveLength(2);

    const global = parsed.find((entry) => entry.id === "wf-global");
    expect(global?.tier).toBe("global");
    expect(global?.name).toBe("Global Methodology");
    expect(global?.parameters).toHaveLength(1);
    expect(global?.prerequisites).toHaveLength(1);

    const project = parsed.find((entry) => entry.id === "wf-project");
    expect(project?.tier).toBe("project");
  });

  it("returns an empty array result when no templates exist in either tier", async () => {
    const listTemplates = vi.fn(async () => []);
    registerTool({ listTemplates });

    const result = (await getHandler("list_templates")({})) as ToolResult;

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as unknown[];
    expect(parsed).toEqual([]);
  });

  it("surfaces a listing failure as an error result", async () => {
    const listTemplates = vi.fn(async () => {
      throw new Error("storage exploded");
    });
    registerTool({ listTemplates });

    const result = (await getHandler("list_templates")({})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("storage exploded");
  });
});
