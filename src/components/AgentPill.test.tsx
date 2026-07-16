// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import AgentPill from "./AgentPill";

afterEach(cleanup);

describe("AgentPill", () => {
  it("renders the catalog label and identity metadata for a known backend", () => {
    render(<AgentPill backend="codex" />);
    const pill = screen.getByText("Codex");
    expect(pill.getAttribute("data-agent")).toBe("codex");
  });

  it("renders an unknown backend id as flagged instead of calling it Claude", () => {
    render(<AgentPill backend={"mystery" as AgentBackendId} />);
    const pill = screen.getByText("mystery");
    expect(pill.getAttribute("data-agent-unknown")).toBe("true");
  });
});
