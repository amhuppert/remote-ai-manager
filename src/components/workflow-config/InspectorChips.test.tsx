// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { modelDisplayLabel } from "@/lib/agent-backends/catalog";
import {
  graphWorkflowAgentConfigSchema,
  validatorAssignmentSchema,
} from "@/lib/workflow-graph/config-schemas";
import {
  BackendChip,
  implementerChipLabel,
  validatorChipLabel,
} from "./InspectorChips";

afterEach(cleanup);

describe("implementerChipLabel / validatorChipLabel", () => {
  it("labels the implementer with the catalog backend label, not the raw id", () => {
    expect(
      implementerChipLabel(
        graphWorkflowAgentConfigSchema.parse({
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        }),
      ),
    ).toBe(`Claude ${modelDisplayLabel("claude", "opus")} · effort=high`);
    expect(
      implementerChipLabel(
        graphWorkflowAgentConfigSchema.parse({
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "medium", fast: "false" },
          },
        }),
      ),
    ).toBe(
      `Codex ${modelDisplayLabel("codex", "gpt-5.4")} · fast=false, reasoning=medium`,
    );
  });

  it("leads with the assignment id so two cohort entries stay distinguishable", () => {
    const parse = (id: string, agent: unknown) =>
      validatorAssignmentSchema.parse({
        id,
        profile: { tier: "builtin", id: "general-reviewer" },
        agent,
      });

    expect(
      validatorChipLabel(
        parse("security", {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        }),
      ),
    ).toBe(
      `security · Claude ${modelDisplayLabel("claude", "sonnet")} · effort=medium`,
    );
    expect(
      validatorChipLabel(
        parse("performance", {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "medium", fast: "false" },
          },
        }),
      ),
    ).toBe(
      `performance · Codex ${modelDisplayLabel("codex", "gpt-5.4")} · fast=false, reasoning=medium`,
    );
  });

  // The catalog holds short ids; every surface that DISPLAYS a model shows the
  // canonical long name, so the short id must not reach the chip text.
  it("shows the canonical long model name rather than the short id", () => {
    const label = implementerChipLabel(
      graphWorkflowAgentConfigSchema.parse({
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      }),
    );
    expect(label).toContain("Opus 5");
    expect(label).not.toContain("Claude opus");
  });
});

describe("BackendChip", () => {
  it("exposes the backend catalog id", () => {
    render(<BackendChip backend="codex">codex chip</BackendChip>);
    const chip = screen.getByText("codex chip");
    expect(chip.getAttribute("data-backend")).toBe("codex");
  });

  it("flags an unknown backend id", () => {
    render(
      <BackendChip backend={"mystery" as AgentBackendId}>chip</BackendChip>,
    );
    const chip = screen.getByText("chip");
    expect(chip.getAttribute("data-backend-unknown")).toBe("true");
  });
});
