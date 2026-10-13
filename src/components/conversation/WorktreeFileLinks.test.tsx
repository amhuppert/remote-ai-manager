// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageContent from "@/components/MessageContent";
import {
  DocumentScopeProvider,
  type DocumentScope,
} from "@/components/conversation/document-scope";
import FilePreviewHost from "@/components/conversation/FilePreviewHost";
import { documentContentKeys } from "@/lib/documents/query-keys";
import { useFilePreviewStore } from "@/stores/file-preview.store";
import { useSessionDetailStore } from "@/stores/session-detail.store";

const WORKTREE = "/Users/alex/repo/.worktrees/notifications";
const PROJECT_ROOT = "/Users/alex/repo";
const IMAGE_URL =
  "/api/projects/proj/sessions/sess/worktree-images?path=.cc%2Ftemp%2Fheld-wake-desktop.png";
const DOC_PATH = "docs/design/agent-subscriptions-controls.md";

const SUMMARY = [
  "Verified the layouts.",
  "",
  `[Desktop preview](${WORKTREE}/.cc/temp/held-wake-desktop.png) · [Design and verification](${WORKTREE}/${DOC_PATH})`,
].join("\n");

const SESSION_SCOPE: DocumentScope = {
  projectName: "proj",
  sessionName: "sess",
  worktreePath: WORKTREE,
  markdownViewer: "pane",
};

function message(text: string): React.JSX.Element {
  return <MessageContent content={[{ type: "text", text }]} />;
}

function renderMessage(
  text: string,
  scope: DocumentScope | null = SESSION_SCOPE,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      {scope ? (
        <DocumentScopeProvider value={scope}>
          {message(text)}
        </DocumentScopeProvider>
      ) : (
        message(text)
      )}
      <FilePreviewHost />
    </QueryClientProvider>,
  );
}

function scoped(text: string) {
  return renderMessage(text);
}

beforeAll(async () => {
  await import("@/components/markdown/MarkdownRenderer");
}, 120_000);

describe("file links in agent messages", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
    useFilePreviewStore.getState().closePreview();
  });

  it("opens a linked Markdown file in the document viewer", async () => {
    const user = userEvent.setup();
    scoped(SUMMARY);

    const chip = await screen.findByRole("button", {
      name: /Design and verification/,
    });
    await user.click(chip);

    const state = useSessionDetailStore.getState();
    expect(state.openDocuments.map((d) => d.docPath)).toEqual([
      "docs/design/agent-subscriptions-controls.md",
    ]);
    expect(state.activeDocPath).toBe(
      "docs/design/agent-subscriptions-controls.md",
    );
    expect(state.rightPaneTab).toBe("docs");
  });

  it("serves a linked worktree image and previews it in a dialog", async () => {
    const user = userEvent.setup();
    scoped(SUMMARY);

    const link = await screen.findByRole("link", { name: /Desktop preview/ });
    expect(link).toHaveAttribute("href", IMAGE_URL);

    await user.click(link);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", IMAGE_URL);
    expect(
      within(dialog).getByRole("heading", { name: "held-wake-desktop.png" }),
    ).toBeInTheDocument();
  });

  it("returns focus to the image link when the preview closes", async () => {
    const user = userEvent.setup();
    scoped(SUMMARY);

    const link = await screen.findByRole("link", { name: /Desktop preview/ });
    await user.click(link);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(link).toHaveFocus();
  });

  it("serves an embedded worktree image and previews it on click", async () => {
    const user = userEvent.setup();
    scoped(`![Held wake](${WORKTREE}/.cc/temp/held-wake-desktop.png)`);

    const image = await screen.findByRole("img", { name: "Held wake" });
    expect(image).toHaveAttribute("src", IMAGE_URL);

    await user.click(screen.getByRole("link", { name: "Held wake" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", IMAGE_URL);
  });

  it("leaves web links as ordinary links", async () => {
    scoped("[Spec](https://example.com/spec.md)");

    const link = await screen.findByRole("link", { name: "Spec" });
    expect(link).toHaveAttribute("href", "https://example.com/spec.md");
  });

  it("opens a worktree HTML report in a new tab", async () => {
    scoped(`[Analysis report](${WORKTREE}/reports/my%20report.html)`);

    const chip = await screen.findByRole("link", { name: /Analysis report/ });
    expect(chip).toHaveAttribute(
      "href",
      "/api/projects/proj/sessions/sess/worktree-html?path=reports%2Fmy%20report.html",
    );
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip).toHaveAttribute("rel", "noopener noreferrer");
    expect(chip).toHaveAccessibleName(/opens in a new tab/i);
    expect(useFilePreviewStore.getState().preview).toBeFalsy();
  });

  it("serves HTML reports from the project root in project conversations", async () => {
    renderMessage(`[Report](${PROJECT_ROOT}/report.htm)`, {
      projectName: "proj",
      sessionName: null,
      worktreePath: PROJECT_ROOT,
    });

    const chip = await screen.findByRole("link", { name: /Report/ });
    expect(chip).toHaveAttribute(
      "href",
      "/api/projects/proj/worktree-html?path=report.htm",
    );
    expect(chip).toHaveAttribute("target", "_blank");
  });

  it("leaves file links unchanged where no session scope is available", async () => {
    renderMessage(SUMMARY, null);

    const link = await screen.findByRole("link", {
      name: "Design and verification",
    });
    expect(link).toHaveAttribute(
      "href",
      `${WORKTREE}/docs/design/agent-subscriptions-controls.md`,
    );
    expect(
      screen.queryByRole("button", { name: /Design and verification/ }),
    ).toBeNull();
  });
  it("previews a linked Markdown file in a dialog where the surface has no docs pane", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(documentContentKeys.content("proj", "sess", DOC_PATH), {
      content: "# Agent subscriptions\n\nControls are verified.",
      docPath: DOC_PATH,
    });
    renderMessage(
      SUMMARY,
      { ...SESSION_SCOPE, markdownViewer: "dialog" },
      client,
    );

    await user.click(
      await screen.findByRole("button", { name: /Design and verification/ }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "agent-subscriptions-controls.md",
    });
    expect(
      await within(dialog).findByText("Controls are verified."),
    ).toBeInTheDocument();
    expect(useSessionDetailStore.getState().openDocuments).toEqual([]);
  });

  it("closes a transient host before a linked file opens and returns focus to its anchor", async () => {
    const user = userEvent.setup();
    const anchor = document.createElement("button");
    anchor.textContent = "Peek anchor";
    document.body.appendChild(anchor);
    const closed: string[] = [];
    renderMessage(SUMMARY, {
      ...SESSION_SCOPE,
      markdownViewer: "dialog",
      transientHost: { close: () => closed.push("closed"), anchor },
    });

    await user.click(
      await screen.findByRole("link", { name: /Desktop preview/ }),
    );
    expect(closed).toEqual(["closed"]);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(anchor).toHaveFocus();
    anchor.remove();
  });

  it("serves images from the project root in a project conversation", async () => {
    const user = userEvent.setup();
    renderMessage(`[Home screen](${PROJECT_ROOT}/.cc/temp/home.png)`, {
      projectName: "proj",
      sessionName: null,
      worktreePath: PROJECT_ROOT,
    });

    const link = await screen.findByRole("link", { name: /Home screen/ });
    expect(link).toHaveAttribute(
      "href",
      "/api/projects/proj/worktree-images?path=.cc%2Ftemp%2Fhome.png",
    );
    await user.click(link);

    const dialog = await screen.findByRole("dialog", { name: "home.png" });
    expect(within(dialog).getByRole("img")).toHaveAttribute(
      "src",
      "/api/projects/proj/worktree-images?path=.cc%2Ftemp%2Fhome.png",
    );
  });

  it("leaves Markdown links ordinary in a project conversation", async () => {
    renderMessage(`[Plan](${PROJECT_ROOT}/docs/plan.md)`, {
      projectName: "proj",
      sessionName: null,
      worktreePath: PROJECT_ROOT,
    });

    const link = await screen.findByRole("link", { name: "Plan" });
    expect(link).toHaveAttribute("href", `${PROJECT_ROOT}/docs/plan.md`);
    expect(screen.queryByRole("button", { name: /Plan/ })).toBeNull();
  });
});
