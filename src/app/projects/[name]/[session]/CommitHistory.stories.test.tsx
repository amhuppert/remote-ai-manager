// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./CommitHistory.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Empty, SingleCommit, MultipleCommits } = composeStories(stories);

describe("CommitHistory stories", () => {
  it("Empty renders empty state", async () => {
    await Empty.run();
    expect(screen.getByText("No commits")).toBeInTheDocument();
  });

  it("SingleCommit renders commit hash and message", async () => {
    await SingleCommit.run();
    expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
    expect(screen.getByText("Add session validation layer")).toBeInTheDocument();
  });

  it("MultipleCommits renders all commits", async () => {
    await MultipleCommits.run();
    expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
    expect(screen.getByText("e5f6g7h")).toBeInTheDocument();
    expect(screen.getByText("i9j0k1l")).toBeInTheDocument();
    expect(screen.getByText("m3n4o5p")).toBeInTheDocument();
  });
});
