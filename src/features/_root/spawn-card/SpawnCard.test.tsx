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
import SpawnCard, { ValidSpawnCard, eligibleTargetBranches } from "./SpawnCard";
import { validateProposal } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal, SpawnResult } from "@/lib/chat-spawning/schemas";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

function renderCard(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function asProposal(candidate: unknown): SpawnProposal {
  const validation = validateProposal(candidate);
  if (validation.kind !== "valid") throw new Error("expected a valid proposal");
  return validation.proposal;
}

const single = asProposal({
  sessions: [{ name: "alpha", agent: "claude", mode: "fast" }],
});

const multi = asProposal({
  sessions: [
    { name: "alpha", agent: "claude", mode: "fast" },
    { name: "beta", agent: "codex", mode: "focus" },
  ],
});

const dual = asProposal({
  sessions: [{ name: "race", agent: "dual", mode: "fast" }],
});

function renderValid(
  proposal: SpawnProposal,
  overrides: Partial<React.ComponentProps<typeof ValidSpawnCard>> = {},
) {
  return renderCard(
    <ValidSpawnCard
      proposal={proposal}
      projectName="repo"
      conversationId="plc-1"
      spawnedStatuses={undefined}
      branchPrefix="csm"
      targetOptions={["main"]}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("eligibleTargetBranches", () => {
  it("includes non-archived session branches and excludes archived ones", () => {
    const branches = eligibleTargetBranches([
      { branchName: "csm/live", archived: false },
      { branchName: "csm/old", archived: true },
      { branchName: "csm/also-live", archived: false },
    ]);
    expect(branches).toEqual(["csm/live", "csm/also-live"]);
  });

  it("returns an empty list when every session is archived", () => {
    const branches = eligibleTargetBranches([
      { branchName: "csm/old", archived: true },
    ]);
    expect(branches).toEqual([]);
  });
});

describe("SpawnCard", () => {
  it("renders a row with name, the name-derived <prefix>/<slug> branch preview, and target", () => {
    renderValid(single);
    expect(screen.getByText("alpha")).toBeTruthy();
    // Branch is derived from the name with the resolved prefix — never proposed.
    expect(screen.getByText("csm/alpha")).toBeTruthy();
    expect(screen.getByText("auto")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("exposes always-editable agent and mode segmented controls", () => {
    renderValid(single);
    expect(
      screen.getByRole("radiogroup", { name: "Session 1 agent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Session 1 mode" }),
    ).toBeTruthy();
  });

  it("tints the Codex agent segment violet (Codex backend identity)", () => {
    renderValid(single);
    const codex = screen.getByRole("radio", { name: "Codex" });
    expect(codex.className).toContain("data-[state=checked]:bg-violet-glow");
    const claude = screen.getByRole("radio", { name: "Claude" });
    expect(claude.className).toContain("data-[state=checked]:bg-cyan-glow");
  });

  it("shows model + reasoning controls for a single-backend agent", () => {
    renderValid(single);
    expect(screen.getByTestId("model-selector-trigger")).toBeTruthy();
    expect(screen.getByTestId("effort-selector-trigger")).toBeTruthy();
  });

  it("hides model + reasoning controls for a dual agent (both run defaults)", () => {
    renderValid(dual);
    expect(screen.queryByTestId("model-selector-trigger")).toBeNull();
    expect(screen.queryByTestId("effort-selector-trigger")).toBeNull();
  });

  it("labels Create with the included count (single)", () => {
    renderValid(single);
    expect(
      screen.getByRole("button", { name: "Create 1 session" }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 1 selected")).toBeTruthy();
  });

  it("labels Create with the included count (multi)", () => {
    renderValid(multi);
    expect(
      screen.getByRole("button", { name: "Create 2 sessions" }),
    ).toBeTruthy();
  });

  it("excluding a session lowers the count; excluding all disables Create", () => {
    renderValid(multi);
    fireEvent.click(
      screen.getByRole("switch", { name: "Create session alpha" }),
    );
    expect(
      screen.getByRole("button", { name: "Create 1 session" }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 2 selected")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "Create session beta" }),
    );
    const create = screen.getByRole("button", {
      name: "Create 0 sessions",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
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

  it("opens an edit pass and submits the edited values (reviewed == created)", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "renamed",
          sessionName: "renamed",
          branchName: "csm/renamed",
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

    renderValid(single);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText(
      "Session 1 name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const sentBody = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ name: string; branch?: string }>;
    };
    expect(sentBody.sessions[0]!.name).toBe("renamed");
    // The branch is never part of the submitted payload — the server derives it.
    expect(sentBody.sessions[0]!.branch).toBeUndefined();

    // Post-create the card surfaces the result instead of the Create control.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Create/ })).toBeNull(),
    );
  });

  it("submits only the included sessions", async () => {
    const result: SpawnResult = { created: [], failed: [] };
    const captured: { body?: string } = {};
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    renderValid(multi);
    fireEvent.click(
      screen.getByRole("switch", { name: "Create session alpha" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const sentBody = JSON.parse(captured.body ?? "{}") as {
      sessions: Array<{ name: string }>;
    };
    expect(sentBody.sessions).toHaveLength(1);
    expect(sentBody.sessions[0]!.name).toBe("beta");
  });

  it("renders passive spawned-session status after creation without drive controls", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "alpha",
          sessionName: "alpha",
          branchName: "csm/alpha",
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

    renderValid(single, {
      spawnedStatuses: [{ sessionName: "alpha", derivedStatus: "running" }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Create 1 session" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    // No control drives a spawned session beyond its first turn.
    expect(
      screen.queryByRole("button", { name: /Run|Stop|Merge|Prompt/ }),
    ).toBeNull();
  });
});
