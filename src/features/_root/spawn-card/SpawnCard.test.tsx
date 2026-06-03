// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import SpawnCard from "./SpawnCard";
import { validateProposal } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnResult } from "@/lib/chat-spawning/schemas";

function renderCard(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const validSingle = validateProposal({
  sessions: [
    { name: "alpha", branch: "feat/alpha", agent: "claude", mode: "fast" },
  ],
});

const validMulti = validateProposal({
  sessions: [
    { name: "alpha", branch: "feat/alpha", agent: "claude", mode: "fast" },
    { name: "beta", branch: "feat/beta", agent: "codex", mode: "focus" },
  ],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpawnCard", () => {
  it("renders one row with name, branch → target, and agent (single proposal)", () => {
    renderCard(
      <SpawnCard
        validation={validSingle}
        projectName="repo"
        conversationId="plc-1"
      />,
    );
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("feat/alpha")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("shows Edit and a single-session Create control", () => {
    renderCard(
      <SpawnCard
        validation={validSingle}
        projectName="repo"
        conversationId="plc-1"
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("shows a Create N sessions control for a multi-session proposal", () => {
    renderCard(
      <SpawnCard
        validation={validMulti}
        projectName="repo"
        conversationId="plc-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Create 2 sessions" }),
    ).toBeTruthy();
  });

  it("renders a non-actionable invalid state with no Create", () => {
    const invalid = validateProposal({ sessions: [] });
    renderCard(
      <SpawnCard
        validation={invalid}
        projectName="repo"
        conversationId="plc-1"
      />,
    );
    expect(screen.getByText("Invalid spawn proposal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });

  it("opens an edit form and submits the edited values (reviewed == created)", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "renamed",
          sessionName: "renamed",
          branchName: "feat/alpha",
          initialPromptDispatched: false,
        },
      ],
      failed: [],
    };
    const captured: { body?: string } = {};
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    renderCard(
      <SpawnCard
        validation={validSingle}
        projectName="repo"
        conversationId="plc-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText(
      "Session 1 name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const sentBody = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ name: string }>;
    };
    expect(sentBody.sessions[0]!.name).toBe("renamed");

    // Post-create the card surfaces the result instead of the Create control.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Create" })).toBeNull(),
    );
  });

  it("renders passive spawned-session status after creation without drive controls", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "alpha",
          sessionName: "alpha",
          branchName: "feat/alpha",
          initialPromptDispatched: true,
        },
      ],
      failed: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    renderCard(
      <SpawnCard
        validation={validSingle}
        projectName="repo"
        conversationId="plc-1"
        spawnedStatuses={[{ sessionName: "alpha", derivedStatus: "running" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    // No control drives a spawned session beyond its first turn.
    expect(
      screen.queryByRole("button", { name: /Run|Stop|Merge|Prompt/ }),
    ).toBeNull();
  });
});
