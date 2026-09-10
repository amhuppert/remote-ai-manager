// @vitest-environment jsdom
//
// The SESSION host's checkpoint wiring, driven through the real info strip.
//
// What matters here is that the two compaction actions stay distinct: the
// artifact item writes a reading document and changes no continuity, while
// "Compact context now" retires the provider context. A surface that collapsed
// them would make one of the two unreachable.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { sessionStateSchema } from "@/lib/sessions/schemas";

import SessionInfoStrip from "./SessionInfoStrip";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app/implement-auth",
  useSearchParams: () => new URLSearchParams(),
}));

const CHECKPOINTS_BASE =
  "/api/projects/my-app/sessions/implement-auth/conversations/conv-1/checkpoints";

const SESSION = sessionStateSchema.parse({
  sessionName: "implement-auth",
  worktreePath: "/tmp/wt/implement-auth",
  branchName: "csm/implement-auth",
  createdAt: "2026-06-30T10:00:00.000Z",
  lastActivityAt: "2026-07-01T12:00:00.000Z",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubStripFetch(options: {
  eligible: boolean;
  queueReviewRequired?: boolean;
}) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith(`${CHECKPOINTS_BASE}/eligibility`)) {
      return jsonResponse({
        eligible: options.eligible,
        refusals: options.eligible
          ? []
          : [
              options.queueReviewRequired === true
                ? {
                    code: "queue_review_required",
                    reason: "a queued delivery is unresolved",
                    operationId: "op-1",
                    phase: "delivering",
                  }
                : {
                    code: "turn_active",
                    reason: "a turn is running",
                    operationId: null,
                    phase: null,
                  },
            ],
        active: null,
        hosted: true,
      });
    }
    if (url.startsWith(CHECKPOINTS_BASE)) {
      return jsonResponse({
        receipts: [
          checkpointReceiptFixture({ operationId: "op-1", phase: "ready" }),
        ],
        nextBefore: null,
      });
    }
    return jsonResponse({ error: "not mocked" }, 404);
  };
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function renderStrip() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionInfoStrip
        session={SESSION}
        activeConversation={undefined}
        projectName="my-app"
        sessionName="implement-auth"
        conversationId="conv-1"
        statusDotClass="status-dot-cyan"
        displayStatus="working"
        contextPercent={null}
        buildContext={() => null}
        tddEnabled={false}
        onTddChange={() => {}}
        tddDisabled={false}
        layout="split"
        onLayoutChange={() => {}}
        dsOpen={false}
        dsServers={[]}
        dsClose={() => {}}
        dsToggle={() => {}}
        dsStartServer={() => {}}
        dsStopServer={() => {}}
        dsStartAll={() => {}}
        dsStopAll={() => {}}
        targetBranch="main"
        onDelete={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("session host checkpoint wiring", () => {
  it("shows the saved checkpoint's phase on its own chip", async () => {
    const { restore } = stubStripFetch({ eligible: true });
    try {
      renderStrip();
      expect(
        await screen.findByRole("button", {
          name: "Context checkpoint: Checkpoint ready — used by the next message",
        }),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("offers the checkpoint action separately from the compaction artifact", async () => {
    const { restore } = stubStripFetch({ eligible: true });
    try {
      renderStrip();
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      });
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /^Actions/ }));

      const checkpointItem = await screen.findByRole("menuitem", {
        name: /Compact context now/,
      });
      const artifactItem = screen.getByRole("menuitem", {
        name: /Generate compaction artifact/,
      });
      expect(checkpointItem).not.toBe(artifactItem);
      expect(checkpointItem).toHaveTextContent(/frozen summary/i);
      expect(artifactItem).toHaveTextContent(/continuity is unchanged/i);
    } finally {
      restore();
    }
  });

  it("disables the checkpoint action with the server's reason and keeps the artifact action usable", async () => {
    const { restore } = stubStripFetch({ eligible: false });
    try {
      renderStrip();
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      });
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /^Actions/ }));

      const checkpointItem = await screen.findByRole("menuitem", {
        name: /Compact context now/,
      });
      expect(checkpointItem).toHaveAttribute("aria-disabled", "true");
      expect(checkpointItem).toHaveTextContent(/A turn is running/i);
      expect(
        screen.getByRole("menuitem", { name: /Generate compaction artifact/ }),
      ).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      restore();
    }
  });

  // The destination must be live in THIS host too. The panel supplies its own
  // (close, then focus the composer's queue review), so a host that wires no
  // callback still reaches the review rather than showing a dead control.
  it("offers a live queue-review destination for unresolved delivery", async () => {
    const stub = stubStripFetch({
      eligible: false,
      queueReviewRequired: true,
    });
    try {
      renderStrip();
      const chip = await screen.findByRole("button", {
        name: /Context checkpoint:/,
      });
      await userEvent.setup().click(chip);
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("button", {
          name: /Review queued messages/i,
        }),
      ).toBeEnabled();
    } finally {
      stub.restore();
    }
  });

  it("opens the checkpoint panel from the chip and shows the saved evidence links", async () => {
    const { calls, restore } = stubStripFetch({ eligible: true });
    try {
      renderStrip();
      const chip = await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      });
      await userEvent.setup().click(chip);

      const dialog = await screen.findByRole("dialog");
      await userEvent
        .setup()
        .click(
          within(dialog).getByRole("button", { name: "Original archive" }),
        );
      expect(
        within(dialog).getByText(/captured through raw seq 148/),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("link", { name: /raw export for seq 148/i }),
      ).toHaveAttribute(
        "href",
        "/api/projects/my-app/sessions/implement-auth/conversations/conv-1/history/entries/148",
      );
      // Reading a checkpoint writes nothing.
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      restore();
    }
  });
});
