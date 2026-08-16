import { describe, expect, it } from "vitest";

import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { graphWorkflowLaunchLabel } from "./launch-presentation";

describe("graphWorkflowLaunchLabel", () => {
  it("owns the display projection for an authored launch", () => {
    expect(
      graphWorkflowLaunchLabel({
        name: "Release direct plan",
        description: "Launch the admitted graph.",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout({ workflowId: "launch-direct-plan" }),
      }),
    ).toBe(
      "Release direct plan · launch-direct-plan · Launch the admitted graph.",
    );
  });
});
