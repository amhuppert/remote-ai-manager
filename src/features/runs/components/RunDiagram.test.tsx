// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { checkoutRun } from "../fixtures";
import { RunDiagram } from "./RunDiagram";

describe("RunDiagram", () => {
  it.each([false, true])("opens a context through Enter and Space in template mode %s", async (template) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <div style={{ width: 1000, height: 600 }}>
        <RunDiagram
          contexts={checkoutRun.contexts}
          edges={checkoutRun.edges}
          lanes={checkoutRun.lanes}
          loops={checkoutRun.loops}
          selectedKey={null}
          onSelect={onSelect}
          template={template}
        />
      </div>,
    );

    // jsdom cannot measure the flow viewport. Its node DOM still exposes the
    // semantic activation surface; browser stories prove measured navigation.
    const node = screen.getByTestId("rf__node-plan");
    const button = within(node).getByRole("button", { hidden: true });
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect.mock.calls).toEqual([["plan"], ["plan"]]);

    // Context buttons own focus. Diagram frames and connections add no dead stops.
    expect(container.querySelectorAll(".react-flow__node[tabindex], .react-flow__edge[tabindex]")).toHaveLength(0);
  });
});
