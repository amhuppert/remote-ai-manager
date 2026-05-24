// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { CapabilitiesSection } from "./CapabilitiesSection";

vi.mock("@/lib/mcp/queries", () => ({
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

vi.mock("@/lib/mcp/mutations", () => ({
  useToggleMcpServerMutation: () => ({ mutate: vi.fn() }),
  useResetMcpServerMutation: () => ({ mutate: vi.fn() }),
  useToggleMcpToolMutation: () => ({ mutate: vi.fn() }),
  useResetMcpToolMutation: () => ({ mutate: vi.fn() }),
  useRefreshMcpToolsMutation: () => ({ mutate: vi.fn() }),
}));

describe("CapabilitiesSection", () => {
  it("renders the AgentCapabilitiesConfigurator with the global scope tab", () => {
    renderWithQuery(<CapabilitiesSection />);
    expect(
      screen.getByRole("heading", { name: /Agent capabilities/i }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /MCP Servers/i })).toBeVisible();
  });
});
