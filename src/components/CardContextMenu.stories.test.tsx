// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./CardContextMenu.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Closed, Open, WithDangerItem } = composeStories(stories);

describe("CardContextMenu stories", () => {
  it("Closed renders the toggle button only", async () => {
    await Closed.run();
    expect(screen.getByLabelText("Project actions")).toBeInTheDocument();
  });

  it("Open renders dropdown items", async () => {
    await Open.run();
    expect(screen.getByText("Pin Project")).toBeInTheDocument();
    expect(screen.getByText("Archive Project")).toBeInTheDocument();
  });

  // Danger appearance is utility-driven and verified visually in Storybook; the
  // story test asserts the danger item renders.
  it("WithDangerItem renders the danger item", async () => {
    await WithDangerItem.run();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
