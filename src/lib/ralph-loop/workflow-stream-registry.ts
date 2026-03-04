/**
 * Per-workflow content streaming to connected UI clients via ReadableStream endpoints.
 * Uses globalThis singleton for HMR safety (same pattern as SSE broadcaster).
 */

import type { MessageContentBlock } from "@/types";
import { getGlobalSingleton } from "../global-singleton";

const GLOBAL_KEY = "__cc_workflow_streams" as const;

export type WorkflowStreamFrame =
  | { type: "content"; iterationNumber: number; content: MessageContentBlock }
  | {
      type: "iteration-boundary";
      iterationNumber: number;
      status: "started" | "completed";
    }
  | { type: "done"; reason: string };

const encoder = new TextEncoder();

function getStreams(): Map<string, Set<ReadableStreamDefaultController>> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<string, Set<ReadableStreamDefaultController>>(),
  );
}

function makeKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Register a stream controller for a workflow. Returns cleanup function. */
export function addClient(
  projectPath: string,
  sessionName: string,
  controller: ReadableStreamDefaultController,
): () => void {
  const key = makeKey(projectPath, sessionName);
  const streams = getStreams();
  if (!streams.has(key)) {
    streams.set(key, new Set());
  }
  streams.get(key)!.add(controller);

  return () => {
    const set = streams.get(key);
    if (set) {
      set.delete(controller);
      if (set.size === 0) {
        streams.delete(key);
      }
    }
  };
}

/** Emit content to all connected stream clients for a workflow. */
export function emit(
  projectPath: string,
  sessionName: string,
  data: WorkflowStreamFrame,
): void {
  const key = makeKey(projectPath, sessionName);
  const set = getStreams().get(key);
  if (!set || set.size === 0) return;

  const encoded = encoder.encode(JSON.stringify(data) + "\n");

  for (const controller of set) {
    try {
      controller.enqueue(encoded);
    } catch {
      set.delete(controller);
    }
  }
}

/** Close all stream clients for a workflow. */
export function closeAll(projectPath: string, sessionName: string): void {
  const key = makeKey(projectPath, sessionName);
  const set = getStreams().get(key);
  if (!set) return;

  for (const controller of set) {
    try {
      controller.close();
    } catch {
      // Already closed
    }
  }

  getStreams().delete(key);
}

/** Check if any clients are connected (for conditional processing). */
export function hasClients(projectPath: string, sessionName: string): boolean {
  const key = makeKey(projectPath, sessionName);
  const set = getStreams().get(key);
  return set != null && set.size > 0;
}

/** Reset for testing */
export function _resetForTesting(): void {
  getStreams().clear();
}
