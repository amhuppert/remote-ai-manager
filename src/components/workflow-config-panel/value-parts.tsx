import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { backendToneToken } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";

/**
 * The summary vocabulary every collapsed row and root-card line speaks: chips
 * for named things (lanes, commands, seats, models), text for counts and
 * qualifiers, and a cyan dot marking a value set at the current tier. Screens
 * build these lists; only this module decides how they look.
 */

export type ConfigTextTone =
  | "dim"
  | "body"
  | "strong"
  | "green"
  | "red"
  | "amber";

export type ConfigValuePart =
  | { kind: "chip"; text: string; tone?: StatusChipTone }
  | { kind: "text"; text: string; tone?: ConfigTextTone }
  /** An emphasised scalar — a count or a resolved literal. */
  | { kind: "value"; text: string }
  /** The set-at-this-tier marker; `title` names what and how many. */
  | { kind: "dot"; title: string };

export function chipPart(
  text: string,
  tone: StatusChipTone = "neutral",
): ConfigValuePart {
  return { kind: "chip", text, tone };
}

export function textPart(
  text: string,
  tone: ConfigTextTone = "body",
): ConfigValuePart {
  return { kind: "text", text, tone };
}

export function valuePart(text: string): ConfigValuePart {
  return { kind: "value", text };
}

export function dotPart(title: string): ConfigValuePart {
  return { kind: "dot", title };
}

/**
 * A backend's identity colour comes from its catalog entry's design-system
 * tone token — the panel never enumerates backends, so violet stays Codex's
 * without this module knowing which backend that is.
 */
export function backendChipTone(backend: AgentBackendId): StatusChipTone {
  const token = backendToneToken(backend);
  return token === "violet" || token === "cyan" || token === "amber"
    ? token
    : "neutral";
}

const TEXT_TONE: Record<ConfigTextTone, string> = {
  dim: "text-text-tertiary",
  body: "text-text-secondary",
  strong: "text-text-primary",
  green: "text-green",
  red: "text-red",
  amber: "text-amber",
};

function partKey(part: ConfigValuePart, index: number): string {
  return `${part.kind}-${part.kind === "dot" ? part.title : part.text}-${index}`;
}

export function ConfigValueParts({
  parts,
}: {
  parts: readonly ConfigValuePart[];
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-[5px] overflow-hidden">
      {parts.map((part, index) => {
        const key = partKey(part, index);
        if (part.kind === "chip") {
          return (
            <StatusChip
              key={key}
              tone={part.tone ?? "neutral"}
              layoutClassName="shrink-0"
            >
              {part.text}
            </StatusChip>
          );
        }
        if (part.kind === "dot") {
          return (
            <span
              key={key}
              title={part.title}
              data-set-here="true"
              className="size-[5px] flex-shrink-0 rounded-full bg-cyan"
            />
          );
        }
        if (part.kind === "value") {
          return (
            <span
              key={key}
              className="min-w-0 truncate font-mono text-[0.72rem] font-medium text-text-primary"
            >
              {part.text}
            </span>
          );
        }
        return (
          <span
            key={key}
            className={cn(
              "min-w-0 truncate font-mono text-[0.72rem]",
              TEXT_TONE[part.tone ?? "body"],
            )}
          >
            {part.text}
          </span>
        );
      })}
    </div>
  );
}
