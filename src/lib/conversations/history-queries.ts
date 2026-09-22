/**
 * Browser reads over the scoped evidence endpoints (design §7).
 *
 * Every URL is built from the owning `ConversationTarget`, so a project
 * conversation reaches its own evidence at its own address and no session path
 * is fabricated for it. Coordinates are the ORIGINAL ones — a raw sequence,
 * and for an image the image-bearing content-block index — exactly as the CLI
 * addresses them; the browser supplies no filesystem path and the server
 * echoes none.
 *
 * These are reads. Opening an entry, resolving a boundary's message index, or
 * viewing an image submits no prompt and has no model-context effect, which is
 * why the surfaces that use them need no admission check at all.
 */

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";

import {
  conversationTargetApiBase,
  conversationTargetKey,
  type ConversationTarget,
} from "./conversation-target";
import { historyEntryMetadataSchema } from "./history-recovery";
import { renderedTranscriptSchema } from "./transcript-render";

export const historyEntryMetadataResponseSchema = z.object({
  entry: historyEntryMetadataSchema,
});

/**
 * The complete entry as the endpoint actually serves it.
 *
 * The export is STREAMED as `text/plain` — the body is exactly the entry's own
 * bytes — and its measurements travel in `x-cc-entry-*` headers so nothing has
 * to be collected to describe them. Only `?format=metadata` answers JSON. A
 * client that parsed this as JSON would fail on every real response, so the
 * text and the headers are read here as the one place that knows the contract.
 */
export interface HistoryEntryExport {
  text: string;
  seq: number;
  kind: string;
  messageIndex: number;
  bytes: number;
  sha256: string;
  includeThinking: boolean;
  thinkingOmitted: number;
  imageCount: number;
}

function headerInt(headers: Headers, name: string): number {
  const raw = headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

async function readHistoryEntryExport(
  url: string,
): Promise<HistoryEntryExport> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`The complete entry at ${url} could not be read`);
  }
  return {
    text: await res.text(),
    seq: headerInt(res.headers, "x-cc-entry-seq"),
    kind: res.headers.get("x-cc-entry-kind") ?? "message",
    messageIndex: headerInt(res.headers, "x-cc-entry-message-index"),
    bytes: headerInt(res.headers, "x-cc-entry-bytes"),
    sha256: res.headers.get("x-cc-entry-sha256") ?? "",
    includeThinking: res.headers.get("x-cc-entry-include-thinking") === "true",
    thinkingOmitted: headerInt(res.headers, "x-cc-entry-thinking-omitted"),
    imageCount: headerInt(res.headers, "x-cc-entry-image-count"),
  };
}

export const historyKeys = {
  all: ["conversation-history"] as const,
  conversation: (target: ConversationTarget) =>
    [...historyKeys.all, ...conversationTargetKey(target)] as const,
  /** One rendered read window — an outline, a message range, or a seq range. */
  read: (target: ConversationTarget, window: ConversationReadWindow) =>
    [...historyKeys.conversation(target), "read", window] as const,
  entryMetadata: (target: ConversationTarget, seq: number) =>
    [...historyKeys.conversation(target), "entry-metadata", seq] as const,
  /** The complete normalized entry, including full tool detail. */
  entry: (target: ConversationTarget, seq: number) =>
    [...historyKeys.conversation(target), "entry", seq] as const,
  /** Recovered original image bytes, addressed exactly as the CLI does. */
  image: (target: ConversationTarget, seq: number, contentBlockIndex: number) =>
    [
      ...historyKeys.conversation(target),
      "image",
      seq,
      contentBlockIndex,
    ] as const,
} as const;

export function historyEntryUrl(
  target: ConversationTarget,
  seq: number,
  options: { includeThinking?: boolean } = {},
): string {
  const base = `${conversationTargetApiBase(target)}/history/entries/${seq}`;
  return options.includeThinking === true
    ? `${base}?includeThinking=true`
    : base;
}

export function historyEntryMetadataUrl(
  target: ConversationTarget,
  seq: number,
): string {
  return `${conversationTargetApiBase(target)}/history/entries/${seq}?format=metadata`;
}

export function historyImageUrl(
  target: ConversationTarget,
  seq: number,
  contentBlockIndex: number,
): string {
  return `${conversationTargetApiBase(target)}/history/images/${seq}/${contentBlockIndex}`;
}

/**
 * What one raw sequence addresses: its merged message index, its size and
 * hash, and the images it displays.
 *
 * This is how a checkpoint boundary — recorded as a raw sequence — becomes a
 * position a reader can navigate to. Resolving it against the archive rather
 * than guessing a message index from a seed's own references is what keeps a
 * derived boundary honest across repeated compaction.
 */
export function useHistoryEntryMetadata(
  target: ConversationTarget,
  seq: number | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: historyKeys.entryMetadata(target, seq ?? -1),
    queryFn: () =>
      apiFetch(
        historyEntryMetadataUrl(target, seq ?? 0),
        historyEntryMetadataResponseSchema,
      ),
    enabled: (options?.enabled ?? true) && seq !== null && seq >= 0,
    // An archive entry is immutable once written, so a resolved coordinate
    // never goes stale within a session.
    staleTime: Infinity,
  });
}

/**
 * The complete entry at one raw sequence, fetched only once a reader asks for
 * it. Opening a checkpoint's receipt never pulls entry bodies into the cache.
 */
export function useHistoryEntry(
  target: ConversationTarget,
  seq: number | null,
  options?: { enabled?: boolean; includeThinking?: boolean },
) {
  const includeThinking = options?.includeThinking ?? false;
  return useQuery({
    queryKey: historyKeys.entry(target, seq ?? -1),
    queryFn: () =>
      readHistoryEntryExport(
        historyEntryUrl(target, seq ?? 0, { includeThinking }),
      ),
    enabled: (options?.enabled ?? false) && seq !== null && seq >= 0,
    staleTime: Infinity,
  });
}

/**
 * The original bytes behind one image handle, as a data URL the panel can
 * render in place.
 *
 * A data URL rather than an object URL on purpose: an object URL must be
 * revoked by whoever created it, and an evidence thumbnail's lifetime is the
 * cache entry's, not the component's — a revoke on unmount would break every
 * other mounted reader of the same cached image. The archive entry is
 * immutable, so the bytes are cached forever and fetched once.
 */
export function useHistoryImage(
  target: ConversationTarget,
  seq: number,
  contentBlockIndex: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: historyKeys.image(target, seq, contentBlockIndex),
    queryFn: async () => {
      const res = await fetch(historyImageUrl(target, seq, contentBlockIndex));
      if (!res.ok) {
        throw new Error(`Image ${seq}/${contentBlockIndex} is unavailable`);
      }
      const buffer = await res.arrayBuffer();
      const mediaType =
        res.headers.get("Content-Type") ?? "application/octet-stream";
      let binary = "";
      for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
      }
      return `data:${mediaType};base64,${btoa(binary)}`;
    },
    enabled: options?.enabled ?? true,
    staleTime: Infinity,
  });
}

/**
 * One window of the conversation's rendered archive, read through the same
 * scoped `/read` route the CLI and agents use.
 *
 * This is how evidence BETWEEN checkpoint boundaries is reachable: a boundary
 * names one coordinate, and an outline over the seq range it closed indexes
 * every logical message inside it. `outline` keeps each unit to one headline
 * so indexing a long range stays cheap; opening any row goes to that entry's
 * own complete export.
 */
export interface ConversationReadWindow {
  outline?: boolean;
  /** Inclusive raw-sequence window, rendered as the route's `A:B` form. */
  seqRange?: readonly [number, number];
  /** Inclusive merged-message window. */
  messageRange?: readonly [number, number];
  includeTools?: "none" | "summary" | "full";
}

export function conversationReadUrl(
  target: ConversationTarget,
  window: ConversationReadWindow,
): string {
  const params = new URLSearchParams();
  if (window.outline === true) params.set("outline", "true");
  if (window.seqRange !== undefined) {
    params.set("seqRange", `${window.seqRange[0]}:${window.seqRange[1]}`);
  }
  if (window.messageRange !== undefined) {
    params.set(
      "messageRange",
      `${window.messageRange[0]}:${window.messageRange[1]}`,
    );
  }
  if (window.includeTools !== undefined) {
    params.set("includeTools", window.includeTools);
  }
  const query = params.toString();
  const base = `${conversationTargetApiBase(target)}/read`;
  return query === "" ? base : `${base}?${query}`;
}

export function useConversationRead(
  target: ConversationTarget,
  window: ConversationReadWindow,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: historyKeys.read(target, window),
    queryFn: () =>
      apiFetch(conversationReadUrl(target, window), renderedTranscriptSchema),
    enabled: options?.enabled ?? false,
    // The window is a range of already-recorded entries, so it cannot change
    // under a reader who is looking at it.
    staleTime: Infinity,
  });
}
