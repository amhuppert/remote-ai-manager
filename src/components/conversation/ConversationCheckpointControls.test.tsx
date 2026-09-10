// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_CHECKPOINT_UPDATED_EVENT,
  type ConversationCheckpointUpdatedEvent,
} from "@/lib/conversation-checkpoints/events";
import {
  checkpointKeys,
  type CheckpointTarget,
} from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import { applyConversationCheckpointUpdatedEvent } from "@/lib/conversation-checkpoints/sse-cache";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";

import ConversationCheckpointControls from "./ConversationCheckpointControls";

const sessionTarget: CheckpointTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const projectTarget: CheckpointTarget = {
  scope: "project",
  projectName: "p1",
  conversationId: "c1",
};

const SESSION_BASE =
  "/api/projects/p1/sessions/s1/conversations/c1/checkpoints";
const PROJECT_BASE = "/api/projects/p1/conversations/c1/checkpoints";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

interface StubState {
  receipts: CheckpointReceipt[];
  eligible: boolean;
  refusals: {
    code: string;
    reason: string;
    operationId: string | null;
    phase: string | null;
  }[];
  active: CheckpointReceipt | null;
  /** Answered to the next POST /checkpoints. */
  startResponse?: () => Response;
}

function stubApi(state: StubState) {
  fetchSpy.mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      if (url.endsWith("/cancel") || url.endsWith("/reconcile")) {
        return Promise.resolve(
          jsonResponse({
            outcome: url.endsWith("/cancel") ? "cancelled" : "repaired",
            receipt: state.receipts[0],
          }),
        );
      }
      return Promise.resolve(
        state.startResponse?.() ??
          jsonResponse(
            {
              outcome: "admitted",
              receipt: checkpointReceiptFixture({
                operationId: "op-new",
                ordinal: 9,
                phase: "building",
              }),
              statusUrl: `${SESSION_BASE}/op-new`,
            },
            202,
          ),
      );
    }
    if (url.includes("/eligibility")) {
      return Promise.resolve(
        jsonResponse({
          eligible: state.eligible,
          refusals: state.refusals,
          active: state.active,
          hosted: true,
        }),
      );
    }
    // The receipt index; the newest operation leads.
    return Promise.resolve(
      jsonResponse({ receipts: state.receipts, nextBefore: null }),
    );
  });
}

function renderControls(
  target: CheckpointTarget = sessionTarget,
  props: Partial<
    React.ComponentProps<typeof ConversationCheckpointControls>
  > = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ConversationCheckpointControls target={target} {...props} />
    </QueryClientProvider>,
  );
  return { client, view };
}

async function openPanel(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: /Context checkpoint:/ }),
  );
}

/** Radix menus open on pointer events, which `userEvent` dispatches. */
async function openMenu(): Promise<void> {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /^Checkpoint$/ }));
}

describe("ConversationCheckpointControls", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("reads the newest operation's phase from the server, not from a mutation", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
      ],
      eligible: false,
      refusals: [],
      active: null,
    });
    renderControls();

    expect(
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      }),
    ).toBeInTheDocument();
  });

  it("distinguishes an applied checkpoint from a ready one", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          phase: "applied",
          hasAcceptedContinuation: true,
        }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();

    expect(
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint applied",
      }),
    ).toBeInTheDocument();
  });

  it("states the acceptance of an applied checkpoint rather than calling it undelivered", async () => {
    // The server derives `hasAcceptedContinuation` from the accepted reference
    // it records with the acceptance itself, so an applied operation always
    // carries both. A panel that read "not delivered" beside "applied" would be
    // describing a receipt the projection cannot produce.
    stubApi({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          phase: "applied",
          hasAcceptedContinuation: true,
        }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();
    await openPanel();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/continued using this saved handoff/),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole("button", { name: /Checkpoint details/ }),
      );
    expect(within(dialog).getByText(/Accepted by attempt/)).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/has not been delivered to a turn yet/),
    ).not.toBeInTheDocument();
  });

  it("restores an in-flight operation after the panel is closed and remounted", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "building" }),
      ],
      eligible: false,
      refusals: [
        {
          code: "checkpoint_pending",
          reason: "a checkpoint is already running",
          operationId: "op-1",
          phase: "building",
        },
      ],
      active: checkpointReceiptFixture({
        operationId: "op-1",
        phase: "building",
      }),
    });
    const { client } = renderControls();

    await openPanel();
    expect(
      await screen.findByText("Building the checkpoint"),
    ).toBeInTheDocument();

    // Close the dialog, then remount the whole surface against the SAME cache:
    // the operation's phase must come back from the query, not from state the
    // unmounted component was holding.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    cleanup();

    render(
      <QueryClientProvider client={client}>
        <ConversationCheckpointControls target={sessionTarget} />
      </QueryClientProvider>,
    );
    await openPanel();
    expect(
      await screen.findByText("Building the checkpoint"),
    ).toBeInTheDocument();
  });

  it("adopts a phase change that arrived over SSE while mounted", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "building" }),
      ],
      eligible: false,
      refusals: [],
      active: null,
    });
    const { client } = renderControls();
    await screen.findByRole("button", {
      name: "Context checkpoint: Building the checkpoint",
    });

    const event: ConversationCheckpointUpdatedEvent = {
      type: CONVERSATION_CHECKPOINT_UPDATED_EVENT,
      scope: "session",
      projectName: "p1",
      sessionName: "s1",
      conversationId: "c1",
      receipt: checkpointReceiptFixture({
        operationId: "op-1",
        phase: "ready",
      }),
    };
    applyConversationCheckpointUpdatedEvent(client, event);

    expect(
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      }),
    ).toBeInTheDocument();
  });

  it("starts a checkpoint with a fresh request id on the addressed scope", async () => {
    stubApi({
      receipts: [],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls(projectTarget);

    await openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Compact context now/ }),
    );

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const post = fetchSpy.mock.calls.find((call) => call[1]?.method === "POST");
    expect(String(post?.[0])).toBe(PROJECT_BASE);
    const body: unknown = JSON.parse(String(post?.[1]?.body));
    expect(body).toMatchObject({});
    const requestId = (body as { requestId?: string }).requestId;
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("disables the action with the server's specific reason while a turn runs", async () => {
    stubApi({
      receipts: [],
      eligible: false,
      refusals: [
        {
          code: "turn_active",
          reason: "a turn is running",
          operationId: null,
          phase: null,
        },
      ],
      active: null,
    });
    renderControls();

    await openMenu();
    const item = await screen.findByRole("menuitem", {
      name: /Compact context now/,
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(/A turn is running/i);
  });

  it("offers no executable action on a backend without checkpoint support", async () => {
    stubApi({
      receipts: [],
      eligible: false,
      refusals: [
        {
          code: "backend_unsupported",
          reason: "backend declares no checkpoint capability",
          operationId: null,
          phase: null,
        },
      ],
      active: null,
    });
    renderControls();

    await openMenu();
    const item = await screen.findByRole("menuitem", {
      name: /Compact context now/,
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(/no checkpoint capability/i);
  });

  it("shows the server's refusal after losing a race, not the stale cached verdict", async () => {
    stubApi({
      receipts: [],
      eligible: true,
      refusals: [],
      active: null,
      startResponse: () =>
        jsonResponse(
          {
            error: "a turn is running",
            code: "conversation_busy",
            refusal: {
              code: "conversation_busy",
              reason: "a turn is running",
              operationId: null,
              phase: null,
            },
            details: {
              refusal: {
                code: "conversation_busy",
                reason: "a turn is running",
                operationId: null,
                phase: null,
              },
            },
          },
          409,
        ),
    });
    renderControls();

    await openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Compact context now/ }),
    );

    await openMenu();
    await waitFor(async () => {
      const item = await screen.findByRole("menuitem", {
        name: /Compact context now/,
      });
      expect(item).toHaveTextContent(/conversation is busy/i);
    });
  });

  // A lost race is a MOMENT, not a verdict. The turn that blocked the start
  // ends, the server says eligible again, and the menu must follow — otherwise
  // one unlucky click disables the action for as long as the host stays
  // mounted.
  it("recovers the action once eligibility is re-read after a lost race", async () => {
    const state: StubState = {
      receipts: [],
      eligible: true,
      refusals: [],
      active: null,
      startResponse: () =>
        jsonResponse(
          {
            error: "a turn is running",
            code: "conversation_busy",
            details: {
              refusal: {
                code: "conversation_busy",
                reason: "a turn is running",
                operationId: null,
                phase: null,
              },
            },
          },
          409,
        ),
    };
    stubApi(state);
    const { client } = renderControls();

    await openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Compact context now/ }),
    );
    await openMenu();
    await waitFor(async () => {
      expect(
        await screen.findByRole("menuitem", { name: /Compact context now/ }),
      ).toHaveTextContent(/conversation is busy/i);
    });
    await userEvent.setup().keyboard("{Escape}");

    // The turn ends; the server's next eligibility read says so.
    await client.invalidateQueries({
      queryKey: checkpointKeys.eligibility(sessionTarget),
    });

    await openMenu();
    await waitFor(async () => {
      const item = await screen.findByRole("menuitem", {
        name: /Compact context now/,
      });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveTextContent(/Retire this context/i);
    });
  });

  it("routes an uncertain queued delivery to queue review instead of a retry", async () => {
    const onReviewQueue = vi.fn();
    stubApi({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          phase: "needs_reconciliation",
          lastStablePhase: "delivering",
        }),
      ],
      eligible: false,
      refusals: [
        {
          code: "queue_review_required",
          reason: "uncertain queued delivery",
          operationId: "op-1",
          phase: "needs_reconciliation",
        },
      ],
      active: checkpointReceiptFixture({
        operationId: "op-1",
        phase: "needs_reconciliation",
      }),
    });
    renderControls(sessionTarget, { onReviewQueue });

    await openPanel();
    const review = await screen.findByRole("button", {
      name: /Review queued messages/,
    });
    fireEvent.click(review);
    expect(onReviewQueue).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /Recovery checkpoint/ }),
    ).toBeNull();
  });

  it("names the operation an explicit recovery supersedes and states it undoes nothing", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-1",
          phase: "needs_reconciliation",
          lastStablePhase: "retiring",
        }),
      ],
      eligible: false,
      refusals: [
        {
          code: "recovery_required",
          reason: "unresolved outcome",
          operationId: "op-1",
          phase: "needs_reconciliation",
        },
      ],
      active: checkpointReceiptFixture({
        operationId: "op-1",
        phase: "needs_reconciliation",
      }),
    });
    renderControls();

    await openPanel();
    expect(
      await screen.findByText(
        "Checkpoint needs reconciliation — interrupted while retiring",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not undo tool effects, file changes/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Recovery checkpoint for op-1" }),
    );
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const post = fetchSpy.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      recoversOperationId: "op-1",
    });
  });

  it("offers cancel only while the build can still be abandoned", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "retiring" }),
      ],
      eligible: false,
      refusals: [],
      active: null,
    });
    renderControls();

    await openPanel();
    expect(
      await screen.findByText("Retiring the current context"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Cancel checkpoint/ }),
    ).toBeNull();
  });

  it("returns focus to the chip that opened the panel", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();

    const user = userEvent.setup();
    const chip = await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });
    await user.click(chip);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The panel is opened from state, not a Radix trigger, so without an
    // explicit restore a keyboard user is dropped at <body>.
    expect(document.activeElement).toBe(chip);
  });

  // Evidence for a conversation that has been compacted repeatedly lives in
  // the EARLIER operations, each with its own boundary, entry export and
  // images. A history rendered as flat labels leaves all of it unreachable.
  it("opens an earlier checkpoint's own evidence from the history list", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({
          operationId: "op-3",
          ordinal: 3,
          phase: "ready",
          capturedThroughSeq: 300,
        }),
        checkpointReceiptFixture({
          operationId: "op-2",
          ordinal: 2,
          phase: "applied",
          capturedThroughSeq: 200,
        }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();
    await openPanel();

    const dialog = await screen.findByRole("dialog");
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: /Original archive/ }));
    expect(
      within(dialog).getByText(/captured through raw seq 300/),
    ).toBeInTheDocument();

    await userEvent
      .setup()
      .click(
        within(dialog).getByRole("button", { name: /Checkpoint history/ }),
      );
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: /#2/ }));

    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: /Original archive/ }));
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Checkpoint applied",
    );
    expect(
      await within(dialog).findByText(/captured through raw seq 200/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /raw export for seq 200/i }),
    ).toHaveAttribute(
      "href",
      "/api/projects/p1/sessions/s1/conversations/c1/history/entries/200",
    );
  });

  // Older history is read by CURSOR, leaving the newest page on its own key:
  // that page is what the chip and the composer's maintenance hold observe, so
  // paging back must not move the query they depend on.
  it("reads further back through the server's own cursor paging", async () => {
    const requested: string[] = [];
    fetchSpy.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/eligibility")) {
        return Promise.resolve(
          jsonResponse({
            eligible: true,
            refusals: [],
            active: null,
            hosted: true,
          }),
        );
      }
      requested.push(url);
      const before = new URL(url, "http://localhost").searchParams.get(
        "before",
      );
      return Promise.resolve(
        jsonResponse(
          before === "6"
            ? {
                receipts: [
                  checkpointReceiptFixture({ operationId: "op-1", ordinal: 1 }),
                ],
                nextBefore: null,
              }
            : {
                receipts: [
                  checkpointReceiptFixture({ operationId: "op-6", ordinal: 6 }),
                ],
                nextBefore: 6,
              },
        ),
      );
    });
    renderControls();
    await openPanel();

    const dialog = await screen.findByRole("dialog");
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole("button", { name: /Checkpoint history/ }),
      );
    await userEvent
      .setup()
      .click(await within(dialog).findByRole("button", { name: /older/i }));

    expect(
      await within(dialog).findByRole("button", { name: /#1/ }),
    ).toBeInTheDocument();
    // The newest page keeps ONE address however often it is re-read, and the
    // older history arrives on a cursor rather than by widening that page.
    expect(requested.some((url) => url.includes("before=6"))).toBe(true);
    const headUrls = new Set(
      requested.filter(
        (url) =>
          url.includes("/checkpoints?") &&
          !url.includes("before=") &&
          !url.includes("detail="),
      ),
    );
    expect([...headUrls]).toEqual([
      "/api/projects/p1/sessions/s1/conversations/c1/checkpoints?limit=5",
    ]);
  });

  it("renders no seed text in the receipt view", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();

    await openPanel();
    await screen.findByText("Checkpoint ready — used by the next message");
    // The seed is disclosed only by an explicit request against `detail=seed`;
    // opening the receipt must not fetch it.
    expect(
      fetchSpy.mock.calls.some((call) =>
        String(call[0]).includes("detail=seed"),
      ),
    ).toBe(false);
  });

  it("keeps technical receipt details behind an explicit disclosure", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();
    await openPanel();

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.queryByText("Seed sha256")).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(dialog.getByRole("button", { name: /Checkpoint details/ }));
    expect(dialog.getByText("Seed sha256")).toBeVisible();
    expect(dialog.getByText("op-1")).toBeVisible();
    expect(
      fetchSpy.mock.calls.some(
        ([input, init]) =>
          String(input).includes("detail=seed") || init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("starts an eligible checkpoint from the dialog and shows its pending state", async () => {
    stubApi({
      receipts: [
        checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
      ],
      eligible: true,
      refusals: [],
      active: null,
    });
    renderControls();
    await openPanel();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Create checkpoint" }));
    await screen.findByText("Building the checkpoint");
    const posts = fetchSpy.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.[0])).toBe(SESSION_BASE);
  });
});
