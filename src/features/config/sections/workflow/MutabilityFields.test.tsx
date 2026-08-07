// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GraphWorkflowMutabilityPolicy } from "@/lib/workflow-graph/config-schemas";
import { MutabilityFields } from "./MutabilityFields";

/**
 * The mutability block carries two independent flags and this editor surfaces
 * only one. An editor that rebuilt the block from the flag it renders would
 * silently turn runtime graph-expansion authority off for every workflow the
 * next time anyone touched the global defaults (D4 R7.1).
 */
describe("MutabilityFields — block round trip", () => {
  it("preserves allowAgentContextAdd when the rendered flag is toggled", () => {
    const onChange = vi.fn();
    const value: GraphWorkflowMutabilityPolicy = {
      allowAgentTaskAdd: false,
      allowAgentContextAdd: true,
    };

    render(<MutabilityFields value={value} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Allow agent task add"));

    expect(onChange).toHaveBeenCalledWith({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    });
  });
});
