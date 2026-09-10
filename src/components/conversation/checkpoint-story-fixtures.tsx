import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import type { CheckpointTarget } from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";

import {
  deriveCheckpointActionState,
  deriveCheckpointChipState,
  checkpointChipIsBusy,
  type CheckpointActionState,
} from "./checkpoint-action-state";
import type { ConversationCheckpointSurface } from "./use-conversation-checkpoint";

/**
 * Story fixtures for the checkpoint surfaces.
 *
 * These serve HTTP, not cache entries. Seeding a query cache directly would
 * skip the readers under test and let a story pass while the client cannot
 * parse what the endpoint actually returns — which is exactly how a
 * complete-entry reader that expected JSON survived a browser pass against a
 * `text/plain` export. The fixture transport therefore answers with the same
 * shapes, content types and headers the production handlers do, and the
 * coordinates are the ones the surfaces address evidence by.
 */

export const STORY_SESSION_TARGET: CheckpointTarget = {
  scope: "session",
  projectName: "command-center",
  sessionName: "implement-auth",
  conversationId: "conv-1",
};

export const STORY_PROJECT_TARGET: CheckpointTarget = {
  scope: "project",
  projectName: "command-center",
  conversationId: "plc-1",
};

/** The raw JSONL coordinate every fixture checkpoint captured through. */
export const STORY_BOUNDARY_SEQ = 148;
/** The merged message index that coordinate resolves to. */
export const STORY_BOUNDARY_MESSAGE_INDEX = 42;

/** Message indices trail their raw sequence; each boundary gets its own. */
function messageIndexFor(seq: number): number {
  return seq === STORY_BOUNDARY_SEQ
    ? STORY_BOUNDARY_MESSAGE_INDEX
    : Math.max(1, Math.floor(seq / 3));
}

export function storyEntryMetadata(
  conversationId: string,
  seq: number = STORY_BOUNDARY_SEQ,
) {
  return {
    conversationId,
    seq,
    kind: "message" as const,
    role: "assistant" as const,
    entryId: `entry-${seq}`,
    timestamp: "2026-09-01T00:00:00.000Z",
    messageIndex: messageIndexFor(seq),
    includeThinking: false,
    thinkingOmitted: 2,
    bytes: 40960,
    sha256: "9f2c1d5e",
    images: [
      {
        conversationId,
        seq,
        contentBlockIndex: 3,
        mediaType: "image/png",
        storage: "external" as const,
        command: `cctl conversation image get ${conversationId} ${seq} 3`,
      },
      {
        conversationId,
        seq,
        contentBlockIndex: 5,
        mediaType: "image/jpeg",
        storage: "inline" as const,
        command: `cctl conversation image get ${conversationId} ${seq} 5`,
      },
    ],
  };
}

/**
 * The complete entry body, served exactly as the export does: the entry's own
 * bytes as `text/plain`, with every measurement in a header.
 */
export function storyCompleteEntryText(seq: number): string {
  return [
    `assistant: running the migration probe [s${seq}]`,
    "",
    "tool_use bash — cctl validate run test --scope changed",
    "tool_result (14382 bytes, complete):",
    "  Test Files  1342 passed (1346)",
    "       Tests  22576 passed (22585)",
    "  Duration  1484.05s",
    "",
    "assistant: the boundary entry is retained verbatim; this is the",
    "complete recorded tool result, not a presentation excerpt.",
  ].join("\n");
}

/**
 * Real bytes for a fixture image. A 2×2 PNG — small enough to inline, real
 * enough that the browser decodes and paints it, which is what makes an image
 * story evidence of recovery rather than of a placeholder.
 */
const STORY_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR42mNk+M9Qz0AEYBxVSF+FAAASbAGl+AQBOgAAAABJRU5ErkJggg==";

function storyImageBytes(): ArrayBuffer {
  const binary = atob(STORY_IMAGE_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * One rendered outline unit, shaped as `renderCompactTranscript` returns it.
 *
 * `merged` models the ordinary case the renderer produces constantly: prose in
 * one raw entry and its tool result or image in the next, collapsed into a
 * single logical message. The export endpoint still serves one raw entry at a
 * time, so a fixture without a merged unit cannot show whether the second
 * coordinate is reachable at all.
 */
function storyOutlineUnit(
  seq: number,
  role: "user" | "assistant",
  merged = false,
) {
  return {
    ref: {
      messageIndex: messageIndexFor(seq),
      messageId: null,
      seqStart: seq,
      seqEnd: merged ? seq + 1 : seq,
    },
    entrySeqs: merged ? [seq, seq + 1] : [seq],
    role,
    timestamp: "2026-09-01T00:00:00.000Z",
    lines: [
      `[s${seq}] ${
        role === "user"
          ? "keep the artifact action separate from the checkpoint"
          : "ran the migration probe and recorded the boundary"
      }`,
    ],
  };
}

function storyReadWindow(
  conversationId: string,
  fromSeq: number,
  toSeq: number,
) {
  const wide = toSeq - fromSeq > 100;
  const seqs = [fromSeq + 4, fromSeq + 18, toSeq].filter(
    (seq, index, all) => seq <= toSeq && all.indexOf(seq) === index,
  );
  return {
    conversationId,
    totalMessages: 60,
    maxSeq: toSeq,
    units: seqs.map((seq, index) =>
      // The first unit merges two raw entries; the rest are single.
      storyOutlineUnit(
        seq,
        index % 2 === 0 ? "assistant" : "user",
        index === 0,
      ),
    ),
    // A wide window models the bounded read: the server stops before the end
    // of the range it was asked for, and the omitted tail has to stay
    // reachable rather than silently vanish.
    truncated: wide,
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
      omittedAfter: wide
        ? {
            nextSeq: fromSeq + 19,
            lastSeq: toSeq,
            unitCount: 4,
            command: `cctl conversation read ${conversationId} --seq-range ${fromSeq + 19}:${toSeq}`,
          }
        : null,
      partialEntry: null,
      excerptedEntries: [],
      excerptedEntriesOmitted: 0,
      excerptedEntriesNext: null,
    },
  };
}

export function storySeed(receipt: CheckpointReceipt) {
  return {
    receipt,
    seed: {
      id: receipt.operationId,
      schemaVersion: 1,
      sourceBasis: receipt.boundary,
      artifactProvenance: null,
      versions: {
        generatorVersion: "g1",
        builderVersion: "b1",
        normalizerVersion: "n1",
      },
      modelSelection: { modelId: "sonnet", parameters: {} },
      sections: { workingState: {}, recentDialogue: {}, recoveryMap: {} },
      seedText: [
        "## Working state",
        "Objective: land the checkpoint UI [#40 118:126]",
        "Blocker: the enabled-backend probe has not run yet [#42 141:148]",
        "",
        "## Recent dialogue",
        "user: keep the artifact action separate [#41 130:134]",
      ].join("\n"),
      seedSha256: "seed-hash",
      sectionBytes: {
        total: 18234,
        workingState: 12000,
        recentDialogue: 5000,
        recoveryFraming: 1234,
      },
      omissions: [{ category: "evidence_map", detail: "trimmed 3 entries" }],
      generationPassCount: 2,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The fixture transport: one router over the scoped evidence routes this
 * conversation actually exposes. Anything it does not recognise falls through
 * to the real `fetch`, so a story that reaches for something unfixtured fails
 * visibly instead of silently reading a stub.
 */
function storyFetch(
  target: CheckpointTarget,
  receipts: readonly CheckpointReceipt[],
  original: typeof fetch,
): typeof fetch {
  const base = conversationTargetApiBase(target);
  return async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(base)) return original(input, init);
    const parsed = new URL(url, window.location.origin);
    const path = parsed.pathname.slice(base.length);

    const entryMatch = /^\/history\/entries\/(\d+)$/.exec(path);
    if (entryMatch !== null) {
      const seq = Number(entryMatch[1]);
      const metadata = storyEntryMetadata(target.conversationId, seq);
      if (parsed.searchParams.get("format") === "metadata") {
        return jsonResponse({ entry: metadata });
      }
      const text = storyCompleteEntryText(seq);
      return new Response(text, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-cc-entry-seq": String(seq),
          "x-cc-entry-kind": metadata.kind,
          "x-cc-entry-message-index": String(metadata.messageIndex),
          "x-cc-entry-bytes": String(new TextEncoder().encode(text).length),
          "x-cc-entry-sha256": metadata.sha256,
          "x-cc-entry-include-thinking": "false",
          "x-cc-entry-thinking-omitted": String(metadata.thinkingOmitted),
          "x-cc-entry-image-count": String(metadata.images.length),
        },
      });
    }

    if (/^\/history\/images\/\d+\/\d+$/.test(path)) {
      return new Response(storyImageBytes(), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (path === "/read") {
      const range = parsed.searchParams.get("seqRange") ?? "0:148";
      const [from, to] = range.split(":").map(Number);
      return jsonResponse(
        storyReadWindow(target.conversationId, from ?? 0, to ?? 148),
      );
    }

    const seedMatch = /^\/checkpoints\/([^/]+)$/.exec(path);
    if (seedMatch !== null && parsed.searchParams.get("detail") === "seed") {
      const operationId = decodeURIComponent(seedMatch[1] ?? "");
      const receipt =
        receipts.find((candidate) => candidate.operationId === operationId) ??
        receipts[0];
      return receipt === undefined
        ? original(input, init)
        : jsonResponse(storySeed(receipt));
    }

    return original(input, init);
  };
}

export interface CheckpointSurfaceFixtureInput {
  target?: CheckpointTarget;
  receipts?: CheckpointReceipt[];
  action?: CheckpointActionState;
  isStarting?: boolean;
  isCancelling?: boolean;
  isReconciling?: boolean;
  requestError?: string | null;
  /** The index holds operations older than `receipts` carries. */
  hasOlder?: boolean;
  onLoadOlder?: () => void;
}

/** A surface object shaped exactly as `useConversationCheckpoint` returns one. */
export function checkpointSurfaceFixture(
  input: CheckpointSurfaceFixtureInput = {},
): ConversationCheckpointSurface {
  const target = input.target ?? STORY_SESSION_TARGET;
  const recent = input.receipts ?? [
    checkpointReceiptFixture({
      operationId: "op-1",
      phase: "ready",
      conversationId: target.conversationId,
      scope: target.scope,
      capturedThroughSeq: STORY_BOUNDARY_SEQ,
    }),
  ];
  const latest = recent[0] ?? null;
  const chip = deriveCheckpointChipState(latest);
  const active = checkpointChipIsBusy(chip) ? latest : null;
  return {
    target,
    latest,
    recent,
    chip,
    action:
      input.action ??
      deriveCheckpointActionState({
        eligibility: {
          eligible: active === null,
          refusals:
            active === null
              ? []
              : [
                  {
                    code: "checkpoint_pending",
                    reason:
                      "A checkpoint is already running for this conversation.",
                    operationId: active.operationId,
                    phase: active.phase,
                  },
                ],
          active,
          hosted: true,
        },
      }),
    isLoading: false,
    isStarting: input.isStarting ?? false,
    isCancelling: input.isCancelling ?? false,
    isReconciling: input.isReconciling ?? false,
    requestError: input.requestError ?? null,
    hasOlder: input.hasOlder ?? false,
    loadOlder: input.onLoadOlder ?? (() => {}),
    isLoadingOlder: false,
    start: () => {},
    startRecovery: () => {},
    cancel: () => {},
    reconcile: () => {},
  };
}

/**
 * Wraps a story in a query client and the fixture transport, so every evidence
 * read the panel makes goes through the production reader against a response
 * shaped like the real one.
 */
export function CheckpointStoryProvider({
  target,
  receipts,
  children,
}: {
  target: CheckpointTarget;
  /** Every saved operation the panel can select, newest first. */
  receipts: readonly CheckpointReceipt[];
  children: ReactNode;
}): React.JSX.Element {
  // Installed during the first render, before any query runs: an effect would
  // land after the panel's first reads had already missed it.
  const [client] = useState(() => {
    const original = window.fetch.bind(window);
    window.fetch = storyFetch(target, receipts, original);
    return {
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
      original,
    };
  });
  useEffect(() => {
    return () => {
      window.fetch = client.original;
    };
  }, [client]);

  return (
    <QueryClientProvider client={client.queryClient}>
      {children}
    </QueryClientProvider>
  );
}
