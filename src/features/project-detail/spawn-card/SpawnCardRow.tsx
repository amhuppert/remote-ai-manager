import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/ui/cn";
import {
  RichPromptInput,
  type RichPromptInputHandle,
} from "@/components/rich-prompt/RichPromptInput";
import { Switch } from "@/components/ui/Switch";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import ModelSelector from "@/components/ModelSelector";
import { useProjectBackendModelOptions } from "@/lib/agent-backends/queries";
import { DEFAULT_AGENT_BACKEND_ID } from "@/lib/shared/schemas";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { sanitizeBranchName } from "@/lib/sessions/branch-name";
import { spawnAgentSchema, spawnModeSchema } from "@/lib/chat-spawning/schemas";
import type { SegmentedControlTone } from "@/components/ui/SegmentedControl";
import {
  effortLevelsForCatalogEntry,
  findBackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import {
  backendForAgent,
  summarizePrompt,
  type EditableField,
  type EditableSession,
} from "./useSpawnCard";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";

/** Spawn agents are catalog backends plus the composite "dual" race. */
function agentLabel(agent: EditableSession["agent"]): string {
  if (agent === "dual") return "Dual";
  return findBackendCatalogEntry(agent)?.label ?? agent;
}

/** Catalog tone for a single-backend agent; the dual race renders cyan. */
function agentTone(agent: EditableSession["agent"]): SegmentedControlTone {
  if (agent === "dual") return "cyan";
  return findBackendCatalogEntry(agent)?.toneToken === "violet"
    ? "violet"
    : "cyan";
}
const MODE_LABEL: Record<EditableSession["mode"], string> = {
  normal: "Normal",
  optimistic: "Optimistic",
};

// Small uppercase mono caption above each control.
const META_LABEL_CLASS =
  "font-mono text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

// Inline editor surface shared by the name input and rich prompt boundary:
// inset base bg, strong border, cyan focus ring — matching the New Session form.
const EDITOR_BASE =
  "rounded-md border border-solid border-border-strong bg-bg-base text-text-primary outline-0 " +
  "transition-[border-color,box-shadow] duration-150 ease-[ease] " +
  "focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)]";

const NAME_INPUT_CLASS = cn(
  EDITOR_BASE,
  "min-w-0 flex-1 px-[9px] py-[4px] font-mono text-[15px] leading-[1.4] font-semibold",
);

// The "auto" affordance: this branch is name-derived, not user-authored.
const AUTO_CHIP_CLASS =
  "rounded-sm border border-solid border-cyan-glow-strong bg-cyan-glow px-[5px] py-px font-mono text-[0.55rem] font-semibold uppercase tracking-[0.08em] text-cyan-dim";

const WONT_CREATE_CHIP_CLASS =
  "ml-auto rounded-sm border border-solid border-border-default bg-bg-base px-[6px] py-[2px] font-mono text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

export interface SpawnCardRowProps {
  projectName: string;
  index: number;
  session: EditableSession;
  /** When true, name/target/prompt become inputs; agent/mode are always editable. */
  editing: boolean;
  /** Effective project branch prefix; the preview is `<prefix>/<slug>` (or just `<slug>` until resolved). */
  branchPrefix: string | undefined;
  /** Merge-target choices (project branches + main). */
  targetOptions: string[];
  /** Whether a long initial prompt is expanded in read mode. */
  expanded: boolean;
  onFieldChange: (index: number, field: EditableField, value: string) => void;
  onIncludedChange: (index: number, included: boolean) => void;
  onImagesChange: (index: number, images: ImagePayload[]) => void;
  onDocumentChange: (index: number, document: SerializedPromptDoc) => void;
  onPrimaryAction(document: SerializedPromptDoc): void;
  onToggleExpanded: (index: number) => void;
}

export interface SpawnCardRowHandle {
  primaryAction(): void;
  isVoiceBusy(): boolean;
}

/**
 * One proposed-session row. A green include switch gates creation; the name,
 * merge target, and initial prompt are read-only until the card enters edit
 * mode, while agent and mode are always-editable segmented controls. The branch
 * is never editable — it is previewed as `<prefix>/<slug>` derived from the name
 * (CC derives the real branch server-side), flagged with an "auto" chip.
 */
const SpawnCardRow = forwardRef<SpawnCardRowHandle, SpawnCardRowProps>(
  function SpawnCardRow(
    {
      projectName,
      index,
      session,
      editing,
      branchPrefix,
      targetOptions,
      expanded,
      onFieldChange,
      onIncludedChange,
      onImagesChange,
      onDocumentChange,
      onPrimaryAction,
      onToggleExpanded,
    }: SpawnCardRowProps,
    ref,
  ): React.JSX.Element {
    const slug = sanitizeBranchName(session.name) || "…";
    const branchPreview = branchPrefix ? `${branchPrefix}/${slug}` : slug;
    const prompt = summarizePrompt(session.initialPrompt, expanded);
    const [hasMountedPrompt, setHasMountedPrompt] = useState(editing);
    if (editing && !hasMountedPrompt) setHasMountedPrompt(true);
    // The concrete backend a single-backend agent runs on; null for the dual race,
    // which has no single model/effort and so hides those controls.
    const backend = backendForAgent(session.agent);
    const backendEntry =
      backend === null ? null : findBackendCatalogEntry(backend);
    // A spawn row always creates sessions inside this project, so its model
    // choices are the project's effective ones (spec D10) rather than the
    // process-global catalog's. The dual race has no single backend to scope,
    // and the hook is called unconditionally, so it asks about the default
    // backend and the result goes unused.
    const projectModelOptions = useProjectBackendModelOptions(
      projectName,
      backend ?? DEFAULT_AGENT_BACKEND_ID,
    );
    const promptRef = useRef<RichPromptInputHandle | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        primaryAction: () => promptRef.current?.primaryAction(),
        isVoiceBusy: () => promptRef.current?.isVoiceBusy() ?? false,
      }),
      [],
    );

    return (
      <div
        className="flex flex-col gap-sm rounded-md border border-l-[3px] border-solid border-border-default border-l-cyan bg-bg-raised px-md py-sm"
        role="group"
        aria-label={`Proposed session ${session.name}`}
      >
        <div className="flex min-h-[34px] items-center gap-sm">
          <Switch
            tone="green"
            checked={session.included}
            onCheckedChange={(checked) => onIncludedChange(index, checked)}
            aria-label={`Create session ${session.name}`}
          />
          {editing ? (
            <input
              className={NAME_INPUT_CLASS}
              aria-label={`Session ${index + 1} name`}
              value={session.name}
              onChange={(e) => onFieldChange(index, "name", e.target.value)}
            />
          ) : (
            <span className="font-mono text-[15px] leading-[1.4] font-semibold text-text-primary">
              {session.name}
            </span>
          )}
          {!session.included && (
            <span className={WONT_CREATE_CHIP_CLASS}>won&apos;t create</span>
          )}
        </div>

        <div className="flex min-h-[32px] flex-wrap items-center gap-sm font-mono text-[0.72rem] text-text-tertiary">
          <span aria-hidden>⎇</span>
          <span className="text-text-secondary">{branchPreview}</span>
          <span className={AUTO_CHIP_CLASS}>auto</span>
          <span>merges into</span>
          {editing ? (
            <span className="inline-block w-[200px] max-w-full">
              <Select
                value={session.target}
                onValueChange={(value) => onFieldChange(index, "target", value)}
              >
                <SelectTrigger
                  aria-label={`Session ${index + 1} target`}
                  layoutClassName="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targetOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          ) : (
            <span className="text-text-secondary">{session.target}</span>
          )}
        </div>

        <div className="flex flex-wrap gap-xl">
          <div className="flex flex-col gap-2xs">
            <span className={META_LABEL_CLASS}>Agent</span>
            <SegmentedControl
              aria-label={`Session ${index + 1} agent`}
              value={session.agent}
              onValueChange={(value) => onFieldChange(index, "agent", value)}
            >
              {spawnAgentSchema.options.map((agent) => (
                <SegmentedControlItem
                  key={agent}
                  value={agent}
                  tone={agentTone(agent)}
                >
                  {agentLabel(agent)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
          <div className="flex flex-col gap-2xs">
            <span className={META_LABEL_CLASS}>Mode</span>
            <SegmentedControl
              aria-label={`Session ${index + 1} mode`}
              value={session.mode}
              onValueChange={(value) => onFieldChange(index, "mode", value)}
            >
              {spawnModeSchema.options.map((mode) => (
                <SegmentedControlItem key={mode} value={mode}>
                  {MODE_LABEL[mode]}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </div>

        {/* Model + reasoning effort apply to a single concrete backend; the dual
          race has no single model/effort, so these are hidden for it. */}
        {backend !== null && (
          <div className="flex flex-wrap items-end gap-xl">
            <div className="flex flex-col gap-2xs">
              <span className={META_LABEL_CLASS}>Model</span>
              <ModelSelector
                backend={backend}
                value={session.model}
                onChange={(model) => onFieldChange(index, "model", model)}
                projectOptions={projectModelOptions}
              />
            </div>
            <div className="flex flex-col gap-2xs">
              <span className={META_LABEL_CLASS}>Reasoning</span>
              <ReasoningLevelSelector
                value={session.reasoningEffort}
                availableLevels={
                  backendEntry
                    ? effortLevelsForCatalogEntry(backendEntry, session.model)
                    : []
                }
                onChange={(level) =>
                  onFieldChange(index, "reasoningEffort", level)
                }
              />
            </div>
          </div>
        )}

        {hasMountedPrompt && (
          <div hidden={!editing} aria-hidden={!editing}>
            <RichPromptInput
              ref={promptRef}
              capabilityContext={{
                projectName,
                backend: backend ?? undefined,
              }}
              ariaLabel={`Session ${index + 1} initial prompt`}
              value={session.initialPrompt}
              onValueChange={(value) =>
                onFieldChange(index, "initialPrompt", value)
              }
              initialImages={session.images}
              onImagesChange={(images) => onImagesChange(index, images)}
              onDocumentChange={(document) => onDocumentChange(index, document)}
              onSubmit={onPrimaryAction}
              submitLabel="Create sessions"
              showSubmitControl={false}
              disabled={!editing}
            />
          </div>
        )}
        {!editing && (
          <div className="min-h-[56px] rounded-md border border-solid border-border-dim bg-bg-base px-[11px] py-[9px] font-body text-[0.78rem] leading-[1.55] text-text-secondary">
            {session.initialPrompt ? (
              <>
                {prompt.display}
                {prompt.long && (
                  <button
                    type="button"
                    onClick={() => onToggleExpanded(index)}
                    className="ml-xs cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.7rem] text-cyan-dim hover:text-cyan"
                  >
                    {expanded ? "Show less" : "Show more"}
                  </button>
                )}
              </>
            ) : (
              <span className="text-text-tertiary">
                No initial prompt — the session starts idle.
              </span>
            )}
          </div>
        )}
      </div>
    );
  },
);

export default SpawnCardRow;
