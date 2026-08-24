import { StatusChip } from "@/components/ui/StatusChip";
import { findBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import type { ActorProvenance } from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

function actorPresentation(actor: ActorProvenance | null): {
  label: string;
  tone: "neutral" | "cyan" | "violet";
  conversationId: string | null;
} {
  if (actor === null) {
    return { label: "Unknown author", tone: "neutral", conversationId: null };
  }
  if (actor.kind === "human") {
    return { label: "Operator", tone: "neutral", conversationId: null };
  }
  const backend = findBackendCatalogEntry(actor.backend ?? "");
  return {
    label: backend === null ? "Agent" : `${backend.label} agent`,
    tone: backend?.id === "codex" ? "violet" : "cyan",
    conversationId: actor.conversationId,
  };
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function SpecActorAttribution({
  action,
  actor,
  occurredAt,
}: {
  action: string;
  actor: ActorProvenance | null;
  occurredAt: string;
}): React.JSX.Element {
  const presentation = actorPresentation(actor);

  return (
    <div className="flex flex-wrap items-center gap-xs font-mono text-[0.68rem] text-text-tertiary">
      <span>{action}</span>
      <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>
      <span aria-hidden="true">·</span>
      <time dateTime={occurredAt}>{formatTimestamp(occurredAt)}</time>
      {presentation.conversationId !== null ? (
        <a
          href={conversationsPageHref({
            conversationId: presentation.conversationId,
          })}
          aria-label={`Open conversation from ${presentation.label} (${presentation.conversationId})`}
          className={cn(
            "inline-flex min-h-[44px] items-center font-semibold underline-offset-2 hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
            presentation.tone === "violet"
              ? "text-violet hover:text-[var(--cc-codex-violet-hover)]"
              : "text-cyan-dim hover:text-cyan",
          )}
        >
          Open conversation ↗
        </a>
      ) : null}
    </div>
  );
}
