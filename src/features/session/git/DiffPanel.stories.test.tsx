// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./DiffPanel.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Empty, SingleFile, MultipleFiles, WithCommits, CommitsOnly } =
  composeStories(stories);

describe("DiffPanel stories", () => {
  it("Empty renders panel header with zero stats", async () => {
    await Empty.run();
    expect(screen.getByText("Diff vs main")).toBeInTheDocument();
    // With no uncommitted files, defaults to commits tab
    expect(screen.getByText("No commits")).toBeInTheDocument();
  });

  it("SingleFile renders file name and stats", async () => {
    await SingleFile.run();
    expect(screen.getByText("src/lib/sessions.ts")).toBeInTheDocument();
    // Single file → +12/-3 render in both the header total and the file row.
    expect(screen.getAllByText("+12").length).toBe(2);
    expect(screen.getAllByText("-3").length).toBe(2);
  });

  it("MultipleFiles renders all file headers", async () => {
    await MultipleFiles.run();
    expect(screen.getByText("src/lib/sessions.ts")).toBeInTheDocument();
    expect(screen.getByText("src/lib/validation.ts")).toBeInTheDocument();
    expect(
      screen.getByText("src/app/api/sessions/route.ts"),
    ).toBeInTheDocument();
  });

  it("WithCommits renders both tab buttons", async () => {
    await WithCommits.run();
    expect(screen.getByText("Uncommitted")).toBeInTheDocument();
    expect(screen.getByText("Commits")).toBeInTheDocument();
  });

  it("CommitsOnly defaults to commits tab when no uncommitted changes", async () => {
    await CommitsOnly.run();
    // With no uncommitted files, the component defaults to the commits tab.
    // The Radix Tabs trigger carries active state via aria-selected (Radix uses
    // aria-selected + data-state, not data-active).
    const commitsTab = screen.getByText("Commits");
    expect(commitsTab).toHaveAttribute("aria-selected", "true");
    // The uncommitted empty state should not be in the DOM
    expect(screen.queryByText("No changes")).toBeNull();
  });
});
