// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { describe, expect, it } from "vitest";

import * as stories from "./SpecPhaseStepper.stories";

describe("SpecPhaseStepper stories", () => {
  it("keeps every lifecycle variant vertically reachable", () => {
    const { LifecycleVariants } = composeStories(stories);

    render(<LifecycleVariants />);

    expect(screen.getByRole("main")).toHaveClass("h-screen", "overflow-y-auto");
  });
});
