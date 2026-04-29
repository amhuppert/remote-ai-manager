/**
 * Graph workflow per-block content streaming — NDJSON transport over
 * `/api/projects/[name]/sessions/[session]/graph-workflow/stream`.
 *
 * This transport is intentionally distinct from StatusBus / SSE
 * (`/api/events`). StatusBus is the lifecycle wire (running/paused/
 * completed/failed envelopes broadcast to every connected client);
 * this registry is the high-frequency content wire (per-block frames
 * delivered to the single active graph-workflow viewer for the
 * session). See `memory-bank/statusbus-graph-stream-boundary.md` for
 * the full rationale and the rules for choosing between the two.
 */
import type { MessageContentBlock } from "@/types";
import { getGlobalSingleton } from "@/lib/global-singleton";

const GLOBAL_KEY = "__cc_graph_workflow_streams" as const;
const encoder = new TextEncoder();

export type GraphWorkflowStreamFrame =
  | {
      type: "content";
      conversationId: string;
      contextId: string;
      content: MessageContentBlock;
    }
  | {
      type: "iteration-boundary";
      conversationId: string;
      contextId: string;
      status: "started" | "completed";
    }
  | { type: "done"; reason: string };

function getStreams(): Map<string, Set<ReadableStreamDefaultController>> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<string, Set<ReadableStreamDefaultController>>(),
  );
}

function makeKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

export function addClient(
  projectPath: string,
  sessionName: string,
  controller: ReadableStreamDefaultController,
): () => void {
  const key = makeKey(projectPath, sessionName);
  const streams = getStreams();
  if (!streams.has(key)) {
    streams.set(key, new Set<ReadableStreamDefaultController>());
  }

  streams.get(key)!.add(controller);

  return () => {
    const set = streams.get(key);
    if (!set) {
      return;
    }

    set.delete(controller);
    if (set.size === 0) {
      streams.delete(key);
    }
  };
}

export function emit(
  projectPath: string,
  sessionName: string,
  frame: GraphWorkflowStreamFrame,
): void {
  const set = getStreams().get(makeKey(projectPath, sessionName));
  if (!set || set.size === 0) {
    return;
  }

  const encoded = encoder.encode(`${JSON.stringify(frame)}\n`);
  for (const controller of set) {
    try {
      controller.enqueue(encoded);
    } catch {
      set.delete(controller);
    }
  }
}

export function _resetForTesting(): void {
  getStreams().clear();
}
