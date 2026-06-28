// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import MessageContent from "@/components/MessageContent";
import { DocumentScopeProvider } from "@/components/conversation/document-scope";
import { useSessionDetailStore } from "@/stores/session-detail.store";

const WORKTREE = "/wt";

function scoped(content: MessageContentBlock[]): React.JSX.Element {
  return (
    <DocumentScopeProvider
      value={{
        projectName: "proj",
        sessionName: "sess",
        worktreePath: WORKTREE,
      }}
    >
      <MessageContent content={content} worktreePath={WORKTREE} />
    </DocumentScopeProvider>
  );
}

describe("MarkdownFileCard in MessageContent", () => {
  beforeEach(() => useSessionDetailStore.getState().resetStore());

  it("renders a card for a Write on a .md and opens it as the active document", async () => {
    const user = userEvent.setup();
    render(
      scoped([
        {
          type: "tool_use",
          id: "t1",
          name: "Write",
          input: { file_path: "/wt/docs/guide.md", content: "# Guide" },
        },
      ]),
    );

    const card = screen.getByRole("button", { name: /guide\.md/ });
    expect(card).toBeInTheDocument();

    await user.click(card);

    const state = useSessionDetailStore.getState();
    expect(state.openDocuments.map((d) => d.docPath)).toEqual([
      "docs/guide.md",
    ]);
    expect(state.activeDocPath).toBe("docs/guide.md");
    expect(state.rightPaneTab).toBe("docs");
  });

  it("clicking a card while in panes layout drops out of panes so the viewer can show", async () => {
    const user = userEvent.setup();
    useSessionDetailStore
      .getState()
      .switchLayout("panes", "cc-test-card-layout");
    render(
      scoped([
        {
          type: "tool_use",
          id: "t1",
          name: "Write",
          input: { file_path: "/wt/docs/guide.md", content: "# Guide" },
        },
      ]),
    );

    await user.click(screen.getByRole("button", { name: /guide\.md/ }));

    const state = useSessionDetailStore.getState();
    expect(state.layout).toBe("default");
    expect(state.activeDocPath).toBe("docs/guide.md");
    expect(state.rightPaneTab).toBe("docs");
  });

  it("keeps the card visible when consecutive tool-uses are grouped/collapsed", () => {
    render(
      scoped([
        {
          type: "tool_use",
          id: "t1",
          name: "Write",
          input: { file_path: "/wt/docs/grouped.md", content: "x" },
        },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
      ]),
    );

    // The two tool-uses collapse into a group, yet the card is surfaced from the
    // message's refs rather than hidden inside the collapsed group.
    expect(screen.getByText("2 tool uses")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /grouped\.md/ }),
    ).toBeInTheDocument();
  });

  it("indicates an out-of-worktree file as unavailable instead of opening", async () => {
    const user = userEvent.setup();
    render(
      scoped([
        {
          type: "tool_use",
          id: "t1",
          name: "Write",
          input: { file_path: "/elsewhere/outside.md", content: "x" },
        },
      ]),
    );

    expect(screen.getByText("outside.md")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    // No actionable button to open it.
    expect(
      screen.queryByRole("button", { name: /outside\.md/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByText("outside.md"));
    expect(useSessionDetailStore.getState().openDocuments).toEqual([]);
  });

  it("renders no file card outside a document scope", () => {
    render(
      <MessageContent
        content={[
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/wt/docs/guide.md", content: "x" },
          },
        ]}
        worktreePath={WORKTREE}
      />,
    );
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
  });
});
