"use client";

import { backendLabel } from "@/lib/agent-backends/catalog";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/ui/cn";
import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationGeneratedArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabAgentModelMeta from "@/features/session/conversation/collab/CollabAgentModelMeta";
import CollabArtifactRefs from "@/features/session/conversation/collab/CollabArtifactRefs";
import { MessageMarkdown } from "@/components/markdown/Markdown";
import { collabAgentTone } from "@/features/session/conversation/collab/card-chrome";

export interface CollabFinalAnswerMessageProps {
  agent: CollaborationAgent;
  modelSettings?: CollaborationAgentModelSettings;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  answer_artifact_id: string;
  artifactFileUrl?: (artifact: CollaborationGeneratedArtifact) => string;
}

// Agent identity accent + role color, keyed on the catalog tone via
// `data-tone` (see card-chrome).
const borderByTone =
  "data-[tone=cyan]:border-l-cyan data-[tone=violet]:border-l-violet data-[tone=amber]:border-l-amber";
const roleColorByTone =
  "data-[tone=cyan]:text-cyan data-[tone=violet]:text-violet data-[tone=amber]:text-amber";

export default function CollabFinalAnswerMessage({
  agent,
  modelSettings,
  summary,
  artifacts,
  answer_artifact_id,
  artifactFileUrl,
}: CollabFinalAnswerMessageProps): React.JSX.Element {
  const tone = collabAgentTone(agent);
  const answerArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === answer_artifact_id),
    [answer_artifact_id, artifacts],
  );
  const answerArtifactUrl = useMemo(
    () =>
      answerArtifact && artifactFileUrl
        ? artifactFileUrl(answerArtifact)
        : null,
    [answerArtifact, artifactFileUrl],
  );
  const [loadedAnswer, setLoadedAnswer] = useState<{
    url: string;
    content: string;
  } | null>(null);
  const [failedAnswerUrl, setFailedAnswerUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!answerArtifactUrl) return;

    const controller = new AbortController();
    fetch(answerArtifactUrl, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`artifact read failed: ${response.status}`);
        }
        return response.text();
      })
      .then((content) => {
        if (!controller.signal.aborted) {
          setLoadedAnswer({ url: answerArtifactUrl, content });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedAnswerUrl(answerArtifactUrl);
      });

    return () => controller.abort();
  }, [answerArtifactUrl]);

  const body =
    loadedAnswer?.url === answerArtifactUrl ? loadedAnswer.content : summary;
  const loadFailed = failedAnswerUrl === answerArtifactUrl;

  return (
    // The component owns `p-md` (its legacy `.collab-final-answer-message`
    // padding). In production (inside `.conversation-virtuoso-item`) the article
    // additionally took a 24px bottom from the shared
    // `.conversation-virtuoso-item .message { padding-bottom }` rule because it
    // carried `.message`. Dropping `.message` (no mixed ownership) is reattached
    // 1:1 with the §8.2 ancestor-context variant so the override still applies
    // in-virtuoso and stays 12px standalone — zero visual change in both. The
    // shared rule itself is untouched (MessageRow owns `.message`).
    // The canonical MessageMarkdown adapter owns the answer body's generated
    // Markdown presentation.
    <article
      className={cn(
        "relative flex flex-col gap-sm rounded-md border border-l-2 border-solid border-border-subtle bg-bg-surface p-md [.conversation-virtuoso-item_&]:pb-[24px]",
        borderByTone,
      )}
      data-agent={agent}
      data-tone={tone}
      data-kind="final_answer"
      aria-label={`Final answer from ${backendLabel(agent)}`}
    >
      <header className="flex items-center gap-sm">
        <span
          className={cn(
            "font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase",
            roleColorByTone,
          )}
          data-tone={tone}
        >
          {backendLabel(agent)}
          <CollabAgentModelMeta settings={modelSettings} />
        </span>
      </header>

      <MessageMarkdown content={body} />
      {loadFailed ? (
        <p className="m-0 font-mono text-[0.72rem] text-text-secondary">
          Full answer artifact could not be loaded.
        </p>
      ) : null}
      <CollabArtifactRefs artifacts={artifacts} />
    </article>
  );
}
