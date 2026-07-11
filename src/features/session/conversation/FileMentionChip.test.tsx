// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentScopeProvider } from "@/components/conversation/document-scope";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { FileMentionChipBody } from "./FileMentionChip";

function renderBody(
  path: string,
  onRemove = vi.fn(),
): ReturnType<typeof render> {
  const basename = path.split("/").pop() ?? path;
  const ext = basename.includes(".") ? (basename.split(".").pop() ?? "") : "";
  return render(
    <DocumentScopeProvider
      value={{ projectName: "proj", sessionName: "sess", worktreePath: "/wt" }}
    >
      <span>
        <FileMentionChipBody
          attrs={{ path, basename, ext }}
          onRemove={onRemove}
        />
      </span>
    </DocumentScopeProvider>,
  );
}

describe("FileMentionChipBody", () => {
  beforeEach(() => useSessionDetailStore.getState().resetStore());

  it("opens a Markdown chip without removing it", async () => {
    const onRemove = vi.fn();
    renderBody("docs/plan.md", onRemove);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Open @docs/plan.md in Markdown viewer",
      }),
    );

    expect(useSessionDetailStore.getState().activeDocPath).toBe("docs/plan.md");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("keeps remove as a separate action", async () => {
    const onRemove = vi.fn();
    renderBody("docs/plan.md", onRemove);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove @docs/plan.md" }),
    );

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(useSessionDetailStore.getState().openDocuments).toEqual([]);
  });

  it("does not make a non-Markdown chip openable", () => {
    renderBody("src/index.ts");
    expect(
      screen.queryByRole("button", {
        name: "Open @src/index.ts in Markdown viewer",
      }),
    ).toBeNull();
  });
});
