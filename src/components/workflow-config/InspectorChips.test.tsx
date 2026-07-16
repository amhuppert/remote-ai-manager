// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  graphWorkflowAgentConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
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
          model: "opus",
          reasoningEffort: "high",
        }),
      ),
    ).toBe("Claude opus · high");
    expect(
      implementerChipLabel(
        graphWorkflowAgentConfigSchema.parse({
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        }),
      ),
    ).toBe("Codex gpt-5.4 · medium");
  });

  it("labels validators with the catalog backend label", () => {
    expect(
      validatorChipLabel(
        graphWorkflowAgentValidatorConfigSchema.parse({
          type: "claude",
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        }),
      ),
    ).toBe("Claude sonnet");
    expect(
      validatorChipLabel(
        graphWorkflowAgentValidatorConfigSchema.parse({ type: "codex" }),
      ),
    ).toBe("Codex default");
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
