// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import Topbar from "@/components/Topbar";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import type { SessionListItem } from "@/lib/sessions/schemas";

// next/link + next/navigation are external framework modules (the sanctioned
// component-mock boundary). The router push spy is shared so selection
// navigation can be asserted as an observable effect.
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

let api: FetchFixture;

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function makeSession(
  overrides: Partial<SessionListItem> & { sessionName: string },
): SessionListItem {
  return {
    worktreePath: `/repos/my-repo/.worktrees/${overrides.sessionName}`,
    branchName: `csm/${overrides.sessionName}`,
    targetBranch: "main",
    parentSessionName: null,
    createdAt: minutesAgo(600),
    lastActivityAt: minutesAgo(600),
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: false,
    derivedStatus: "idle",
    promptCount: 1,
    derivedLastActivityAt: minutesAgo(600),
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    spawnedFrom: null,
    ...overrides,
  };
}

const SESSIONS: SessionListItem[] = [
  makeSession({
    sessionName: "sess-active",
    derivedStatus: "running",
    derivedLastActivityAt: minutesAgo(30),
  }),
  makeSession({
    sessionName: "sess-waiting",
    derivedStatus: "waiting_for_input",
    derivedLastActivityAt: minutesAgo(2),
  }),
  makeSession({
    sessionName: "sess-merged",
    finished: true,
    derivedStatus: "idle",
    derivedLastActivityAt: minutesAgo(300),
  }),
  makeSession({
    sessionName: "sess-archived",
    archived: true,
    derivedLastActivityAt: minutesAgo(1),
  }),
];

const PROJECTS = [
  {
    name: "my-repo",
    path: "/repos/my-repo",
    activeSessions: 3,
    hasRunningSession: true,
  },
  {
    name: "alpha",
    path: "/repos/alpha",
    activeSessions: 1,
    hasRunningSession: false,
  },
  {
    name: "beta",
    path: "/repos/beta",
    activeSessions: 0,
    hasRunningSession: true,
  },
  {
    name: "old-tools",
    path: "/repos/old-tools",
    activeSessions: 0,
    hasRunningSession: false,
  },
];

const DETAIL_BREADCRUMBS = [
  { label: "projects", href: "/projects" },
  { label: "my-repo", href: "/projects/my-repo", isProject: true },
  {
    label: "sess-active",
    href: "/projects/my-repo/sess-active",
    isSession: true,
  },
];

function renderDetailTopbar() {
  return renderWithQuery(
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      <Topbar breadcrumbs={DETAIL_BREADCRUMBS} page="detail" />
    </HotkeyProvider>,
  );
}

function renderTopbarWithHotkeys(topbar: React.ReactElement) {
  return renderWithQuery(
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      {topbar}
    </HotkeyProvider>,
  );
}

async function openProjectSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "my-repo" }));
  return screen.findByPlaceholderText("Search projects…");
}

async function openSessionSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "sess-active" }));
  return screen.findByPlaceholderText("Search sessions…");
}

beforeAll(() => {
  // Tiptap (inside the lazily-mounted CreateSessionModal) needs Range geometry
  // that jsdom does not implement.
  document.elementFromPoint = () => document.body;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

beforeEach(() => {
  push.mockClear();
  api = installFetchFixture();
  api.json("GET", "/api/notifications", {
    notifications: [],
    total: 0,
    unreadCount: 0,
  });
  api.json("GET", "/api/conversations/active", {
    conversations: [],
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
  });
  api.json("GET", "/api/projects", PROJECTS);
  api.json("GET", "/api/projects/preferences", {
    archived: ["/repos/old-tools"],
    pinned: ["/repos/alpha"],
  });
  api.json("GET", "/api/projects/my-repo/sessions", { sessions: SESSIONS });
  api.json("GET", "/api/projects/my-repo/branch-prefix", {
    branchPrefix: "csm",
  });
});

afterEach(() => {
  api.restore();
});

describe("Topbar project switcher", () => {
  it("renders the project breadcrumb as a dropdown trigger and the root as a plain link", () => {
    renderDetailTopbar();
    expect(screen.getByRole("button", { name: "my-repo" })).toBeInTheDocument();
    const root = screen.getByText("projects").closest("a");
    expect(root?.getAttribute("href")).toBe("/projects");
  });

  it("lists pinned projects first, excludes archived, and highlights the active project", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openProjectSwitcher(user);

    expect(await screen.findByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("All projects")).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent);
    expect(labels).toEqual(["alpha", "my-repo", "beta"]);
    expect(screen.queryByText("old-tools")).toBeNull();

    const active = screen.getByRole("option", { name: "my-repo" });
    expect(active).toHaveAttribute("aria-selected", "true");
    // Running projects show the cyan running dot; non-running do not.
    expect(active.querySelector("[data-tone='cyan']")).not.toBeNull();
    const alpha = screen.getByRole("option", { name: "alpha" });
    expect(alpha.querySelector("[data-tone]")).toBeNull();
  });

  it("filters projects by substring and shows the empty state", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    const input = await openProjectSwitcher(user);

    await user.type(input, "alp");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "alpha",
    ]);

    await user.clear(input);
    await user.type(input, "zzz");
    expect(await screen.findByText("No projects match")).toBeInTheDocument();
  });

  it("navigates to the selected project's landing page", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openProjectSwitcher(user);

    await user.click(screen.getByRole("option", { name: "beta" }));
    expect(push).toHaveBeenCalledWith("/projects/beta");
  });

  it("supports arrow-key navigation and Enter selection from the search input", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    const input = await openProjectSwitcher(user);
    await screen.findAllByRole("option");

    // Focus lands in the search field on open.
    expect(input).toHaveFocus();

    // Highlight starts on the first row (alpha); one ArrowDown reaches my-repo.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledWith("/projects/my-repo");
  });
});

describe("Topbar session switcher", () => {
  it("lists the project's sessions most-recent first with status dots, times, and active highlight", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openSessionSwitcher(user);
    const options = await screen.findAllByRole("option");

    // Sorted by derivedLastActivityAt desc; archived sessions excluded.
    expect(options.map((o) => o.textContent)).toEqual([
      "sess-waiting2m",
      "sess-active30m",
      "sess-merged5h",
    ]);

    expect(options[0]!.querySelector("[data-tone='amber']")).not.toBeNull();
    expect(options[1]!.querySelector("[data-tone='cyan']")).not.toBeNull();
    // Finished sessions render the dimmed merged dot, not a glowing StatusDot.
    expect(options[2]!.querySelector("[data-tone]")).toBeNull();

    const active = screen.getByRole("option", { name: /sess-active/ });
    expect(active).toHaveAttribute("aria-selected", "true");
  });

  it("navigates to the selected session", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openSessionSwitcher(user);
    await screen.findAllByRole("option");

    await user.click(screen.getByRole("option", { name: /sess-waiting/ }));
    expect(push).toHaveBeenCalledWith("/projects/my-repo/sess-waiting");
  });

  it("filters sessions and shows the empty state", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    const input = await openSessionSwitcher(user);
    await screen.findAllByRole("option");

    await user.type(input, "nope");
    expect(await screen.findByText("No sessions match")).toBeInTheDocument();
  });

  it("opens the existing create-session modal from the New session action", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openSessionSwitcher(user);

    await user.click(await screen.findByText("New session"));
    // The real CreateSessionModal (lazy-loaded) mounts with its dialog title.
    expect(await screen.findByText("New Session")).toBeInTheDocument();
  });

  it("renders the session segment as a plain link when no project segment exists", () => {
    renderWithQuery(
      <Topbar
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          { label: "orphan", href: "/projects/p/orphan", isSession: true },
        ]}
        page="detail"
      />,
    );
    expect(screen.queryByRole("button", { name: "orphan" })).toBeNull();
    expect(screen.getByText("orphan").closest("a")).not.toBeNull();
  });
});

describe("Topbar switcher hotkeys", () => {
  it("opens the project and session switchers with their G sequences", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();

    await user.keyboard("gp");
    expect(
      await screen.findByPlaceholderText("Search projects…"),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();

    await user.keyboard("gs");
    const sessionSearch =
      await screen.findByPlaceholderText("Search sessions…");
    expect(sessionSearch).toHaveFocus();
  });

  it("closes the open switcher with Escape", async () => {
    const user = userEvent.setup();
    renderDetailTopbar();
    await openProjectSwitcher(user);

    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
  });

  it.each([
    ["project", "p", "Search projects…"],
    ["session", "s", "Search sessions…"],
  ])(
    "returns prompt focus after closing the %s switcher",
    async (_switcher, key, searchName) => {
      renderWithQuery(
        <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
          <div
            contentEditable
            data-cc-prompt-id="prompt-a"
            data-testid="prompt"
          >
            preserve this draft
          </div>
          <Topbar breadcrumbs={DETAIL_BREADCRUMBS} page="detail" />
        </HotkeyProvider>,
      );
      const prompt = screen.getByTestId("prompt");
      prompt.focus();
      const caret = document.createRange();
      caret.setStart(prompt.firstChild!, 8);
      caret.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(caret);

      fireEvent.keyDown(prompt, {
        key: ";",
        code: "Semicolon",
        ctrlKey: true,
      });
      fireEvent.keyUp(prompt, {
        key: ";",
        code: "Semicolon",
        ctrlKey: true,
      });
      fireEvent.keyUp(prompt, {
        key: "Control",
        code: "ControlLeft",
      });
      fireEvent.keyDown(prompt, { key: "g", code: "KeyG" });
      fireEvent.keyDown(prompt, {
        key,
        code: `Key${key.toUpperCase()}`,
      });

      expect(
        await screen.findByRole("combobox", { name: searchName }),
      ).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

      await waitFor(() => expect(prompt).toHaveFocus());
      expect(prompt).toHaveTextContent("preserve this draft");
      expect(window.getSelection()?.focusOffset).toBe(8);
    },
  );

  it("opens the global project switcher on pages without a project segment", async () => {
    const user = userEvent.setup();
    renderTopbarWithHotkeys(
      <Topbar breadcrumbs={[{ label: "tickets" }]} page="tickets" />,
    );
    await user.keyboard("gp");
    expect(
      await screen.findByPlaceholderText("Search projects…"),
    ).toHaveFocus();
  });
});
