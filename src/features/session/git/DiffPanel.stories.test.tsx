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
    // File-level stat is inside the diff-file-stat span
    const fileStat = document.querySelector(".diff-file-stat");
    expect(fileStat?.textContent).toContain("+12");
    expect(fileStat?.textContent).toContain("-3");
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
    // With no uncommitted files, the component defaults to the commits tab
    const commitsTab = screen.getByText("Commits");
    expect(commitsTab.className).toContain("active");
    // The uncommitted empty state should not be in the DOM
    expect(screen.queryByText("No changes")).toBeNull();
  });
});
