import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("agent instruction and canonical documentation contracts", () => {
  it("keeps tool-agnostic instructions canonical and Claude guidance additive", () => {
    const agents = read("AGENTS.md");
    const claude = read("CLAUDE.md");

    expect(agents).toContain("bun install");
    expect(agents).toContain(".kiro/steering/agent-backends.md");
    expect(claude).toContain("@AGENTS.md");
    expect(claude).not.toContain("memory-bank/focus.md");
    expect(claude).not.toContain("ai-resources:browser-automation");
    expect(`${agents}\n${claude}`).not.toContain("git checkout HEAD --");
  });

  it("describes the neutral backend and current session-creation model", () => {
    const product = read(".kiro/steering/product.md");
    const tech = read(".kiro/steering/tech.md");

    expect(product).toContain("Claude and Codex");
    expect(product).not.toContain("Fast and Focus creation modes");
    expect(tech).toContain("src/lib/agent-backends/");
    expect(tech).not.toContain("Claude Code driven via");
    expect(existsSync(resolve(root, ".kiro/steering/agent-backends.md"))).toBe(
      true,
    );
  });

  it("routes state resolution and SSE through their canonical seams", () => {
    const structure = read(".kiro/steering/structure.md");
    const logs = read(".kiro/steering/logs.md");
    const notifications = read(".kiro/steering/notifications.md");

    expect(structure).toContain("RouteResolution");
    expect(logs).toContain("backendRef");
    expect(logs).not.toContain("claudeSessionId");
    expect(logs).toContain("events/publication.ts");
    expect(notifications).toContain("PublishFn");
    expect(notifications).not.toContain("Internal SSE broadcasts");
  });

  it("keeps Claude schema compatibility adapter-owned", () => {
    const structured = read("docs/structured-data-responses.md");

    expect(structured).toContain("projectSchemaForClaude");
    expect(structured).toContain("Codex receives the unmodified schema");
    expect(structured).not.toContain(
      "src/lib/workflows/collaboration/schemas.test.ts",
    );
  });

  it("labels completed and historical documents truthfully", () => {
    expect(read("docs/composable-workflow-primitives.md")).toContain(
      "Superseded",
    );
    expect(
      read(
        "docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md",
      ).slice(0, 1_000),
    ).toContain("Implemented");
    expect(
      read("docs/design/2026-07-12_phase-1-slice-designs.md"),
    ).not.toContain("needs Alex sign-off");
    expect(read("docs/design/conversation-compaction/README.md")).toContain(
      "**Status:** Implemented",
    );
    expect(read("docs/design/cc-cli/README.md")).toContain(
      "**Status:** Implemented",
    );
    expect(read("docs/design/cc-cli/06-workflow-live-editing.md")).toContain(
      "Status: **implemented**",
    );
  });

  it("keeps operator and AI-output guidance current", () => {
    const logging = read("docs/logging.md");
    const aiOutput = read("docs/ai-validation-output.md");

    expect(logging).not.toContain("cc-debug.log");
    expect(logging).not.toContain("/api/hooks");
    expect(logging).toContain(".kiro/steering/logs.md");
    expect(aiOutput).toContain("AI_OUTPUT=1");
  });
});
