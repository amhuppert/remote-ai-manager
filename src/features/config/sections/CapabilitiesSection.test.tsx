// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { CapabilitiesSection } from "./CapabilitiesSection";

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
  // The MCP panel mounts at global scope and reads the global config; holding it
  // in perpetual loading keeps this render assertion free of MCP fixture data.
  api.pending("GET", "/api/config/mcp");
});

afterEach(() => {
  api.restore();
});

describe("CapabilitiesSection", () => {
  it("renders the AgentCapabilitiesConfigurator with the global scope tab", () => {
    renderWithQuery(<CapabilitiesSection />);
    expect(
      screen.getByRole("heading", { name: /Agent capabilities/i }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /MCP Servers/i })).toBeVisible();
  });
});
