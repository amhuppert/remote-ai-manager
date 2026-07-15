// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import AgentPill from "./AgentPill";

afterEach(cleanup);

describe("AgentPill", () => {
  it("renders the catalog label and identity tone for a known backend", () => {
    render(<AgentPill backend="codex" />);
    const pill = screen.getByText("Codex");
    expect(pill.getAttribute("data-agent")).toBe("codex");
    expect(pill.className).toContain("text-violet");
  });

  it("renders an unknown backend id as a flagged neutral pill, not as Claude", () => {
    render(<AgentPill backend={"mystery" as AgentBackendId} />);
    const pill = screen.getByText("mystery");
    expect(pill.getAttribute("data-agent-unknown")).toBe("true");
    expect(pill.className).not.toContain("text-cyan");
    expect(pill.className).not.toContain("text-violet");
  });
});
