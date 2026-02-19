// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./CommitDialog.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Default, Closed } = composeStories(stories);

describe("CommitDialog stories", () => {
  it("Default renders commit form with textarea", async () => {
    await Default.run();
    expect(screen.getByText("Commit Changes")).toBeInTheDocument();
    expect(screen.getByText("Commit Message")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Describe your changes..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
  });

  it("Closed renders nothing when open=false", async () => {
    await Closed.run();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});
