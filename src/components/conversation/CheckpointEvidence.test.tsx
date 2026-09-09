// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";

import CheckpointEvidence from "./CheckpointEvidence";

const sessionTarget: ConversationTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};
const projectTarget: ConversationTarget = {
  scope: "project",
  projectName: "p1",
  conversationId: "c1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

function entryMetadata(seq: number, messageIndex: number) {
  return {
    entry: {
      conversationId: "c1",
      seq,
      kind: "message" as const,
      role: "assistant" as const,
      entryId: "e-1",
      timestamp: "2026-09-01T00:00:00.000Z",
      messageIndex,
      includeThinking: false,
      thinkingOmitted: 0,
      bytes: 4096,
      sha256: "entry-hash",
      images: [
        {
          conversationId: "c1",
          seq,
          contentBlockIndex: 3,
          mediaType: "image/png",
          storage: "external" as const,
          command: `cctl conversation image get c1 ${seq} 3`,
        },
      ],
    },
  };
}

function stubApi(options: { seedText?: string } = {}) {
  fetchSpy.mockImplementation((input) => {
    const url = String(input);
    if (url.includes("format=metadata")) {
      return Promise.resolve(jsonResponse(entryMetadata(148, 42)));
    }
    if (url.includes("detail=seed")) {
      return Promise.resolve(
        jsonResponse({
          receipt: checkpointReceiptFixture(),
          seed: {
            id: "op-1",
            schemaVersion: 1,
            sourceBasis: { capturedThroughSeq: 148, sourceHash: "source-hash" },
            artifactProvenance: null,
            versions: {
              generatorVersion: "g1",
              builderVersion: "b1",
              normalizerVersion: "n1",
            },
            modelSelection: { modelId: "sonnet", parameters: {} },
            sections: { workingState: {}, recentDialogue: {}, recoveryMap: {} },
            seedText: options.seedText ?? "OBJECTIVE: ship the checkpoint",
            seedSha256: "seed-hash",
            sectionBytes: {
              total: 18234,
              workingState: 12000,
              recentDialogue: 5000,
              recoveryFraming: 1234,
            },
            omissions: [],
            generationPassCount: 2,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      );
    }
    if (url.includes("/read?")) {
      return Promise.resolve(
        jsonResponse({
          conversationId: "c1",
          totalMessages: 60,
          maxSeq: 148,
          units: [
            {
              ref: {
                messageIndex: 40,
                messageId: null,
                seqStart: 120,
                seqEnd: 121,
              },
              entrySeqs: [120, 121],
              role: "assistant",
              timestamp: "2026-09-01T00:00:00.000Z",
              lines: ["[s120] ran the migration probe"],
            },
            {
              ref: {
                messageIndex: 42,
                messageId: null,
                seqStart: 148,
                seqEnd: 148,
              },
              entrySeqs: [148],
              role: "user",
              timestamp: "2026-09-01T00:01:00.000Z",
              lines: ["[s148] keep the artifact action separate"],
            },
          ],
          truncated: false,
          omissions: {
            thinkingOmitted: 0,
            toolResultBytesElided: 0,
            unitsOutsideWindow: 0,
          },
          boundaries: {
            entries: [],
            totalInRange: 0,
            nextBefore: null,
            indexCommand: null,
          },
          truncation: {
            omittedAfter: null,
            partialEntry: null,
            excerptedEntries: [],
            excerptedEntriesOmitted: 0,
            excerptedEntriesNext: null,
          },
        }),
      );
    }
    if (url.includes("/history/images/")) {
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    }
    if (url.includes("/history/entries/")) {
      // The real contract: the export is STREAMED as text/plain and its
      // measurements travel in headers. A JSON body here would be an invented
      // response that hides whether the reader can parse the actual endpoint.
      return Promise.resolve(
        new Response("the complete recorded tool result", {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-cc-entry-seq": "148",
            "x-cc-entry-kind": "message",
            "x-cc-entry-message-index": "42",
            "x-cc-entry-bytes": "4096",
            "x-cc-entry-sha256": "entry-hash",
            "x-cc-entry-include-thinking": "false",
            "x-cc-entry-thinking-omitted": "0",
            "x-cc-entry-image-count": "1",
          },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderEvidence(
  props: Partial<React.ComponentProps<typeof CheckpointEvidence>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CheckpointEvidence
        target={sessionTarget}
        receipt={checkpointReceiptFixture({ capturedThroughSeq: 148 })}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("CheckpointEvidence", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("resolves the saved boundary to a message index and offers navigation", async () => {
    stubApi();
    const onNavigateToMessage = vi.fn();
    renderEvidence({ onNavigateToMessage });

    const goto = await screen.findByRole("button", {
      name: /Go to message #42/,
    });
    await userEvent.setup().click(goto);
    expect(onNavigateToMessage).toHaveBeenCalledWith(42);
    expect(screen.getByText(/raw seq 148/)).toBeInTheDocument();
  });

  it("links the complete entry export and each image at the session scope", async () => {
    stubApi();
    renderEvidence();

    const entryLink = await screen.findByRole("link", {
      name: /raw export/i,
    });
    expect(entryLink).toHaveAttribute(
      "href",
      "/api/projects/p1/sessions/s1/conversations/c1/history/entries/148",
    );
    // Modal panel: following evidence in place would tear down the view it
    // belongs to, so every evidence link opens beside it.
    expect(entryLink).toHaveAttribute("target", "_blank");
    const imageLink = await screen.findByRole("link", { name: /image/i });
    expect(imageLink).toHaveAttribute(
      "href",
      "/api/projects/p1/sessions/s1/conversations/c1/history/images/148/3",
    );
  });

  it("addresses a project conversation without a fabricated session path", async () => {
    stubApi();
    renderEvidence({ target: projectTarget });

    const entryLink = await screen.findByRole("link", {
      name: /raw export/i,
    });
    expect(entryLink).toHaveAttribute(
      "href",
      "/api/projects/p1/conversations/c1/history/entries/148",
    );
    expect(
      fetchSpy.mock.calls.every(
        (call) => !String(call[0]).includes("/sessions/"),
      ),
    ).toBe(true);
  });

  it("discloses the exact saved handoff only when asked", async () => {
    stubApi({ seedText: "OBJECTIVE: ship the checkpoint" });
    renderEvidence();

    await screen.findByText(/raw seq 148/);
    expect(
      fetchSpy.mock.calls.some((call) =>
        String(call[0]).includes("detail=seed"),
      ),
    ).toBe(false);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /saved handoff/i }));

    expect(
      await screen.findByText("OBJECTIVE: ship the checkpoint"),
    ).toBeInTheDocument();
  });

  it("marks a rolling artifact that covers later history than the checkpoint", async () => {
    stubApi();
    renderEvidence({
      artifact: { coveredEndSeq: 400, updatedAt: "2026-09-02T00:00:00.000Z" },
    });

    expect(
      await screen.findByText(
        /covers later history than this saved checkpoint/i,
      ),
    ).toBeInTheDocument();
  });

  it("does not mark an artifact that is older than the checkpoint", async () => {
    stubApi();
    renderEvidence({
      artifact: { coveredEndSeq: 100, updatedAt: "2026-08-01T00:00:00.000Z" },
    });

    await screen.findByText(/raw seq 148/);
    expect(
      screen.queryByText(/covers later history than this saved checkpoint/i),
    ).toBeNull();
  });

  // Linking out to a binary endpoint is not "viewing the evidence": the panel
  // is modal, so a new tab tears the reader away from the conversation the
  // evidence belongs to. Opening it in place is what makes the archive
  // actually reachable — and it is still a read.
  it("opens the complete entry in place, with its full tool detail", async () => {
    stubApi();
    renderEvidence();
    await screen.findByText(/message #42/);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /open complete entry/i }));

    expect(
      await screen.findByText(/the complete recorded tool result/i),
    ).toBeInTheDocument();
  });

  // A checkpoint boundary is one coordinate; the evidence a reader needs is the
  // RANGE it closed. The scoped read route already serves an outline over a seq
  // range, so the panel indexes that window instead of stopping at one entry.
  it("outlines the archive range this checkpoint closed", async () => {
    stubApi();
    renderEvidence({ previousBoundarySeq: 96 });
    await screen.findByText(/message #42/);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /archive outline/i }));

    expect(
      await screen.findByRole("button", {
        name: /ran the migration probe/i,
      }),
    ).toBeInTheDocument();
    const readCall = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/read?"));
    expect(readCall).toContain("outline=true");
    expect(readCall).toContain("seqRange=97%3A148");
  });

  it("opens an outlined entry's own complete export, not the boundary's", async () => {
    stubApi();
    renderEvidence({ previousBoundarySeq: 96 });
    await screen.findByText(/message #42/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /archive outline/i }));
    await user.click(
      await screen.findByRole("button", { name: /ran the migration probe/i }),
    );

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls
          .map((call) => String(call[0]))
          .some((url) => url.endsWith("/history/entries/120")),
      ).toBe(true),
    );
  });

  it("renders the recovered image bytes for each handle", async () => {
    stubApi();
    renderEvidence();

    const image = await screen.findByRole("img", {
      name: /image at block 3/i,
    });
    await waitFor(() =>
      expect(image).toHaveAttribute("src", expect.stringContaining("data:")),
    );
  });

  it("submits nothing — viewing evidence issues no write at all", async () => {
    stubApi();
    renderEvidence();
    await screen.findByText(/raw seq 148/);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /saved handoff/i }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) =>
          String(call[0]).includes("detail=seed"),
        ),
      ).toBe(true),
    );

    expect(
      fetchSpy.mock.calls.every(
        (call) => (call[1]?.method ?? "GET").toUpperCase() === "GET",
      ),
    ).toBe(true);
  });
});

/**
 * The renderer merges several raw entries into one logical message, but the
 * complete-entry endpoint exports ONE raw entry. A unit whose prose is at 120
 * and whose tool result and image are at 121 therefore hides 121 entirely if
 * the row only ever opens `ref.seqStart` — the evidence a reader came for is
 * the one coordinate they cannot reach.
 */
describe("CheckpointEvidence merged units", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("exposes every raw entry a merged unit covers", async () => {
    stubApi();
    const user = userEvent.setup();
    renderEvidence();
    await user.click(screen.getByRole("button", { name: /archive outline/i }));

    // Both coordinates of the merged unit are offered, not just its start.
    const entry121 = await screen.findByRole("button", {
      name: /open complete entry at seq 121/i,
    });
    await user.click(entry121);

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls
          .map(([input]) => String(input))
          .some((url) => url.endsWith("/history/entries/121")),
      ).toBe(true),
    );
  });

  // The same window, but the server's byte budget stopped inside it.
  const truncatedRead = {
    conversationId: "c1",
    totalMessages: 60,
    maxSeq: 148,
    units: [
      {
        ref: { messageIndex: 40, messageId: null, seqStart: 100, seqEnd: 100 },
        entrySeqs: [100],
        role: "assistant" as const,
        timestamp: "2026-09-01T00:00:00.000Z",
        lines: ["[s100] first"],
      },
    ],
    truncated: true,
    omissions: {
      thinkingOmitted: 0,
      toolResultBytesElided: 0,
      unitsOutsideWindow: 0,
    },
    boundaries: {
      entries: [],
      totalInRange: 0,
      nextBefore: null,
      indexCommand: null,
    },
    truncation: {
      omittedAfter: {
        nextSeq: 101,
        lastSeq: 148,
        unitCount: 7,
        command: "cctl conversation read c1 --seq-range 101:148",
      },
      partialEntry: null,
      excerptedEntries: [],
      excerptedEntriesOmitted: 0,
      excerptedEntriesNext: null,
    },
  };

  it("offers a continuation for entries a bounded outline never reached", async () => {
    stubApi();
    const base = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/read?")) {
        return Promise.resolve(jsonResponse(truncatedRead));
      }
      return base!(input, init);
    });

    const user = userEvent.setup();
    renderEvidence();
    await user.click(screen.getByRole("button", { name: /archive outline/i }));

    // The reader is told what was left out and given the way to reach it.
    expect(
      await screen.findByRole("button", { name: /show seq 101–148/i }),
    ).toBeEnabled();
  });

  it("stops offering continuations once a narrower window is complete", async () => {
    stubApi();
    // The wide read is truncated; the narrower read the continuation requests is
    // not. Without a terminating condition the panel would keep offering a next
    // window forever, so the chain has to end where the archive does.
    const base = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/read?")) {
        return Promise.resolve(
          jsonResponse(
            url.includes("101%3A148") || url.includes("101:148")
              ? {
                  ...truncatedRead,
                  units: [
                    {
                      ref: {
                        messageIndex: 41,
                        messageId: null,
                        seqStart: 101,
                        seqEnd: 101,
                      },
                      entrySeqs: [101],
                      role: "assistant" as const,
                      timestamp: "2026-09-01T00:00:00.000Z",
                      lines: ["[s101] the tail the wide window never reached"],
                    },
                  ],
                  truncated: false,
                  truncation: {
                    omittedAfter: null,
                    partialEntry: null,
                    excerptedEntries: [],
                    excerptedEntriesOmitted: 0,
                    excerptedEntriesNext: null,
                  },
                }
              : truncatedRead,
          ),
        );
      }
      if (base === undefined) throw new Error("no base fetch stub");
      return base(input, init);
    });

    const user = userEvent.setup();
    renderEvidence();
    await user.click(screen.getByRole("button", { name: /archive outline/i }));
    await user.click(
      await screen.findByRole("button", { name: /show seq 101–148/i }),
    );

    // The continuation rendered the tail the wide window never reached, and
    // offers no further window beyond it.
    expect(
      await screen.findByRole("button", {
        name: /s101 assistant · \[s101\] the tail the wide window never reached/i,
      }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /^show seq /i }),
    ).not.toBeInTheDocument();
  });
});
