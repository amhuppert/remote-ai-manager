"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MessageContentBlock, TranscriptMessage } from "@/types";
import type { WorkflowStreamFrame } from "@/lib/ralph-loop/workflow-stream-registry";

interface LiveIterationStreamProps {
  projectName: string;
  sessionName: string;
  iterationNumber: number;
  isRunning: boolean;
  currentIterationConversationId: string | null;
}

interface StreamEntry {
  id: number;
  frame: WorkflowStreamFrame;
}

function renderContentBlock(block: MessageContentBlock, key: number) {
  switch (block.type) {
    case "text":
      return (
        <div key={key} className="stream-text">
          {block.text}
        </div>
      );
    case "tool_use":
      return (
        <div key={key} className="stream-tool">
          <span className="stream-tool-name">{block.name}</span>
        </div>
      );
    case "tool_result":
      return (
        <div key={key} className="stream-tool-result">
          {block.content ?? ""}
        </div>
      );
    default:
      return null;
  }
}

/**
 * Extract assistant content blocks from transcript messages into StreamEntry format.
 * Returns the entries and the total block count (used for stream deduplication).
 */
function transcriptToEntries(
  messages: TranscriptMessage[],
  iterationNumber: number,
  entryIdRef: React.RefObject<number>,
): { entries: StreamEntry[]; blockCount: number } {
  const entries: StreamEntry[] = [];
  let blockCount = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (
        block.type === "text" ||
        block.type === "tool_use" ||
        block.type === "tool_result"
      ) {
        const id = ++entryIdRef.current;
        entries.push({
          id,
          frame: { type: "content", iterationNumber, content: block },
        });
        blockCount++;
      }
    }
  }

  return { entries, blockCount };
}

export default function LiveIterationStream({
  projectName,
  sessionName,
  iterationNumber,
  isRunning,
  currentIterationConversationId,
}: LiveIterationStreamProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef(0);

  // Deduplication: skip stream content frames that were already loaded from transcript
  const skipCountRef = useRef(0);
  const skippedRef = useRef(0);
  // Buffer stream frames that arrive before transcript loads
  const streamBufferRef = useRef<WorkflowStreamFrame[]>([]);
  const initializedRef = useRef(false);

  // Reset state on new connection (state-during-render pattern for state,
  // effect for refs since refs cannot be accessed during render)
  const [prevStreamKey, setPrevStreamKey] = useState({
    isRunning,
    iterationNumber,
  });
  if (
    isRunning !== prevStreamKey.isRunning ||
    iterationNumber !== prevStreamKey.iterationNumber
  ) {
    setPrevStreamKey({ isRunning, iterationNumber });
    if (isRunning) {
      setEntries([]);
      setIsDone(false);
      setExpanded(false);
    }
  }

  // Reset refs in an effect (cannot access refs during render)
  useEffect(() => {
    if (isRunning) {
      skipCountRef.current = 0;
      skippedRef.current = 0;
      streamBufferRef.current = [];
      initializedRef.current = false;
    }
  }, [isRunning, iterationNumber]);

  const processStream = useCallback(
    async (signal: AbortSignal) => {
      const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow/stream`;

      try {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const frame = JSON.parse(trimmed) as WorkflowStreamFrame;
              if (frame.type === "done") {
                setIsDone(true);
              } else if (frame.type === "content") {
                // If transcript hasn't loaded yet, buffer the frame
                if (!initializedRef.current) {
                  streamBufferRef.current.push(frame);
                  continue;
                }
                // Skip frames already covered by transcript
                if (skippedRef.current < skipCountRef.current) {
                  skippedRef.current++;
                  continue;
                }
                const id = ++entryIdRef.current;
                setEntries((prev) => [...prev, { id, frame }]);
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
      } catch {
        if (signal.aborted) return;
        // Connection error — stream will be retried on next SSE trigger
      }
    },
    [projectName, sessionName],
  );

  useEffect(() => {
    if (!isRunning) return;

    entryIdRef.current = 0;
    skipCountRef.current = 0;
    skippedRef.current = 0;
    streamBufferRef.current = [];
    initializedRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;

    const run = async () => {
      // Start stream connection immediately — frames buffer until transcript loads
      const streamPromise = processStream(controller.signal);

      // In parallel, load existing transcript if we have a conversationId
      if (currentIterationConversationId) {
        try {
          const msgUrl = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(currentIterationConversationId)}/messages`;
          const res = await fetch(msgUrl, { signal: controller.signal });
          if (res.ok) {
            const messages = (await res.json()) as TranscriptMessage[];
            const { entries: transcriptEntries, blockCount } =
              transcriptToEntries(messages, iterationNumber, entryIdRef);

            skipCountRef.current = blockCount;

            // Flush buffered stream frames — skip duplicates, keep new ones
            const newEntries: StreamEntry[] = [];
            let bufferSkipped = 0;
            for (const frame of streamBufferRef.current) {
              if (frame.type === "content" && bufferSkipped < blockCount) {
                bufferSkipped++;
                continue;
              }
              if (frame.type === "content") {
                const id = ++entryIdRef.current;
                newEntries.push({ id, frame });
              }
            }
            skippedRef.current = bufferSkipped;
            streamBufferRef.current = [];
            initializedRef.current = true;

            setEntries([...transcriptEntries, ...newEntries]);
          } else {
            // Transcript fetch failed — flush buffer as-is, no dedup
            initializedRef.current = true;
            const buffered: StreamEntry[] = streamBufferRef.current
              .filter(
                (f): f is WorkflowStreamFrame & { type: "content" } =>
                  f.type === "content",
              )
              .map((frame) => ({
                id: ++entryIdRef.current,
                frame,
              }));
            streamBufferRef.current = [];
            if (buffered.length > 0) {
              setEntries(buffered);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
          // Transcript fetch failed — flush buffer as-is
          initializedRef.current = true;
          const buffered: StreamEntry[] = streamBufferRef.current
            .filter(
              (f): f is WorkflowStreamFrame & { type: "content" } =>
                f.type === "content",
            )
            .map((frame) => ({
              id: ++entryIdRef.current,
              frame,
            }));
          streamBufferRef.current = [];
          if (buffered.length > 0) {
            setEntries(buffered);
          }
        }
      } else {
        // No conversationId — stream-only mode (no transcript to load)
        initializedRef.current = true;
        const buffered: StreamEntry[] = streamBufferRef.current
          .filter(
            (f): f is WorkflowStreamFrame & { type: "content" } =>
              f.type === "content",
          )
          .map((frame) => ({
            id: ++entryIdRef.current,
            frame,
          }));
        streamBufferRef.current = [];
        if (buffered.length > 0) {
          setEntries(buffered);
        }
      }

      await streamPromise;
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState calls are async (after await fetch), not synchronous
    void run();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [
    isRunning,
    iterationNumber,
    currentIterationConversationId,
    processStream,
    projectName,
    sessionName,
  ]);

  // Auto-scroll to bottom when expanded
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, expanded]);

  const entryCount = entries.length;
  const toolCount = entries.filter(
    (e) => e.frame.type === "content" && e.frame.content.type === "tool_use",
  ).length;

  return (
    <div className="workflow-live-output">
      <button
        className="live-output-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="live-indicator">
          {!isDone && <span className="live-dot" />}
          Iteration {iterationNumber} {isDone ? "complete" : "in progress"}
        </span>
        <span className="live-output-summary">
          {entryCount > 0 && (
            <span className="live-output-counts">
              {entryCount} events
              {toolCount > 0 ? ` \u00B7 ${toolCount} tools` : ""}
            </span>
          )}
          <span className={`live-output-arrow${expanded ? " expanded" : ""}`}>
            {"\u25B8"}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="live-stream-content" ref={scrollRef}>
          {entries.map((entry) => {
            if (entry.frame.type === "content") {
              return renderContentBlock(entry.frame.content, entry.id);
            }
            return null;
          })}
          {isDone && <div className="stream-done">Iteration complete</div>}
          {entries.length === 0 && !isDone && (
            <div className="stream-waiting">Waiting for Claude output...</div>
          )}
        </div>
      )}
    </div>
  );
}
