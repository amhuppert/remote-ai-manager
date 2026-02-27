// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./Topbar.stories";

beforeAll(storybookAnnotations.beforeAll);

const { ProjectsPage, SessionsPage, DetailPage, DeepBreadcrumbs } =
  composeStories(stories);

describe("Topbar stories", () => {
  it("ProjectsPage renders logo and global status", async () => {
    await ProjectsPage.run();
    expect(screen.getByText("CC")).toBeInTheDocument();
    expect(screen.getByText("3 projects")).toBeInTheDocument();
  });

  it("SessionsPage renders project breadcrumb", async () => {
    await SessionsPage.run();
    expect(screen.getByText("my-app")).toBeInTheDocument();
    expect(screen.getByText("2 active sessions")).toBeInTheDocument();
  });

  it("DetailPage renders session controls", async () => {
    await DetailPage.run();
    expect(screen.getByText("implement-auth")).toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
  });

  it("DeepBreadcrumbs renders long project and session names", async () => {
    await DeepBreadcrumbs.run();
    expect(screen.getByText("remote-ai-manager")).toBeInTheDocument();
    expect(screen.getByText("refactor-state-machine")).toBeInTheDocument();
  });
});
