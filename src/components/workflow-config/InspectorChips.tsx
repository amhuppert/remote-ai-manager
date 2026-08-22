import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  findBackendCatalogEntry,
  modelDisplayLabel,
} from "@/lib/agent-backends/catalog";
import type {
  GraphWorkflowAgentConfig,
  ValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import { cn } from "@/lib/ui/cn";

// Shared glyphs + chips for the workflow inspector rails. Backend identity
// colors key off each backend's catalog-declared design-system tone, and the
// gate glyphs (script / approval / questions) reuse one vocabulary across the
// resolved-setup strip and the config blocks.

interface IconProps {
  size?: number;
}

export function BackendGlyphIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 1.7 14.3 8 8 14.3 1.7 8Z" />
    </svg>
  );
}

export function ScriptGlyphIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="1.9" y="3.2" width="12.2" height="9.6" rx="1.6" />
      <path
        d="M4.6 6.6 6.7 8 4.6 9.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.4 9.6h3.1" strokeLinecap="round" />
    </svg>
  );
}

export function ApprovalGlyphIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path
        d="M3.2 8.4 6.4 11.6 12.8 4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function QuestionGlyphIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <path
        d="M6.1 6.2a1.9 1.9 0 0 1 3.7.6c0 1.3-1.8 1.5-1.8 2.8"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.7" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The output-contract glyph: a diamond outline, distinct from the filled
 * backend diamond so a Schema chip never reads as an agent identity. */
export function SchemaGlyphIcon({ size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" strokeLinejoin="round" />
    </svg>
  );
}

export function EditGlyphIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path
        d="M10.4 2.6 13.4 5.6 5.6 13.4 2.6 13.4 2.6 10.4Z"
        strokeLinejoin="round"
      />
      <path d="M9.2 3.8 12.2 6.8" strokeLinecap="round" />
    </svg>
  );
}

export function ExpandGlyphIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M9.5 2.5H13.5V6.5M13.5 2.5 9 7M6.5 13.5H2.5V9.5M2.5 13.5 7 9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function chipBackendLabel(id: string): string {
  return findBackendCatalogEntry(id)?.label ?? id;
}

// Config holds the SHORT model id; the chip shows the catalog's canonical long
// name, matching every other surface that displays a model.
function chipAgentLabel(config: GraphWorkflowAgentConfig): string {
  return `${chipBackendLabel(config.backend)} ${modelDisplayLabel(config.backend, config.model)}`;
}

export function implementerChipLabel(config: GraphWorkflowAgentConfig): string {
  const effort = config.reasoningEffort;
  const agent = chipAgentLabel(config);
  return effort ? `${agent} · ${effort}` : agent;
}

// The assignment id leads: with a cohort, "which reviewer" is the first thing
// the chip has to answer, and two entries can share a backend and model.
export function validatorChipLabel(validator: ValidatorAssignment): string {
  return `${validator.id} · ${chipAgentLabel(validator.agent)}`;
}

const CHIP_BASE =
  "inline-flex items-center gap-[5px] whitespace-nowrap rounded-sm border border-solid px-sm py-[2px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.05em]";

// Identity color keyed by the catalog's design-system tone token; the catalog
// owns which backend maps to which tone.
const TONE_CHIP_CLASS: Record<string, string> = {
  cyan: "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a06)] text-cyan",
  violet: "border-[var(--cc-codex-violet-a35)] bg-violet-glow text-violet",
};

// An id the catalog does not know renders flagged-neutral rather than
// borrowing another backend's identity color.
const UNKNOWN_CHIP_CLASS =
  "border-border-default bg-bg-raised text-text-secondary";

export function BackendChip({
  backend,
  children,
}: {
  backend: AgentBackendId;
  children: React.ReactNode;
}): React.JSX.Element {
  const entry = findBackendCatalogEntry(backend);
  const toneClass =
    (entry ? TONE_CHIP_CLASS[entry.toneToken] : undefined) ??
    UNKNOWN_CHIP_CLASS;
  return (
    <span
      className={cn(CHIP_BASE, toneClass)}
      data-backend={backend}
      data-backend-unknown={entry ? undefined : "true"}
    >
      <BackendGlyphIcon />
      {children}
    </span>
  );
}

export type GateChipTone = "neutral" | "amber";

const GATE_CHIP_CLASS: Record<GateChipTone, string> = {
  neutral:
    "border-border-default bg-[var(--cc-graph-ink-a55)] text-text-primary",
  amber: "border-amber-dim bg-amber-glow text-amber",
};

export function GateChip({
  tone,
  icon,
  children,
}: {
  tone: GateChipTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className={cn(CHIP_BASE, GATE_CHIP_CLASS[tone])}>
      {icon}
      {children}
    </span>
  );
}
