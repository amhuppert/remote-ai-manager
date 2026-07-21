// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { describe, expect, it } from "vitest";

import * as stories from "./SpecControls.stories";

describe("SpecControls stories", () => {
  it("keeps long mobile execution surfaces vertically reachable", () => {
    const { RunningExecution } = composeStories(stories);

    render(<RunningExecution />);

    expect(screen.getByRole("main")).toHaveClass("h-screen", "overflow-y-auto");
  });
});
