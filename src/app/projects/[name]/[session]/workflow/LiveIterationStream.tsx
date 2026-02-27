"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MessageContentBlock } from "@/types";
import type { WorkflowStreamFrame } from "@/lib/ralph-loop/workflow-stream-registry";

interface LiveIterationStreamProps {
  projectName: string;
  sessionName: string;
  iterationNumber: number;
  isRunning: boolean;
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

export default function LiveIterationStream({
  projectName,
  sessionName,
  iterationNumber,
  isRunning,
}: LiveIterationStreamProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef(0);

  // Reset state on new connection (state-during-render pattern)
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
    const controller = new AbortController();
    abortRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState calls are async (after await fetch), not synchronous
    void processStream(controller.signal);

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [isRunning, iterationNumber, processStream]);

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
