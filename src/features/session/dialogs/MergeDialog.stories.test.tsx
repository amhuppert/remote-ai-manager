// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./MergeDialog.stories";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/git/mutations", () => ({
  useMergeMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeAll(storybookAnnotations.beforeAll);

const { Default, SingleCommit, ManyCommits, Closed } = composeStories(stories);

describe("MergeDialog stories", () => {
  it("Default renders branch info and merge form", async () => {
    await Default.run();
    expect(screen.getByText("Merge into main")).toBeInTheDocument();
    expect(screen.getByText("csm/implement-auth")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
  }, 30000);

  it("SingleCommit renders with 1 commit", async () => {
    await SingleCommit.run();
    expect(screen.getByText("csm/quick-fix")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("ManyCommits renders with high commit count", async () => {
    await ManyCommits.run();
    expect(screen.getByText("csm/major-refactor")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
  });

  it("Closed renders nothing when open=false", async () => {
    await Closed.run();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});
