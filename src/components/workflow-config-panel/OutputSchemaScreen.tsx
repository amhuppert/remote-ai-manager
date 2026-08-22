"use client";

import { MultilineInput } from "@/components/MultilineInput";
import { cn } from "@/lib/ui/cn";
import { isConfigLocked } from "./affordance";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import { AlertTriangleIcon, CheckIcon } from "./icons";
import {
  outputSchemaLintCard,
  OUTPUT_SCHEMA_DISABLED_HINT,
  type OutputSchemaLintCard,
} from "./schema-lint";
import type { ContextStructuralEditor } from "./structural-editor";

/**
 * Output schema — the declaration this context's captured payload is held to
 * (Config Panel `schemaRows()`).
 *
 * The text is the value: it is never round-tripped through a parse, so a
 * half-typed declaration survives a re-render and, more importantly, the last
 * schema that PARSED is never what a save would persist under red text. What
 * makes the text acceptable is not decided here — `outputSchemaLintCard`
 * delegates to the walker the engine's own accept path refuses with.
 */

const TONE_BOX: Record<OutputSchemaLintCard["tone"], string> = {
  green: "border-green-dim bg-green-glow",
  red: "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)]",
  neutral: "border-border-subtle bg-bg-raised",
};

const TONE_TEXT: Record<OutputSchemaLintCard["tone"], string> = {
  green: "text-green",
  red: "text-red",
  neutral: "text-text-tertiary",
};

function LintIcon({
  tone,
}: {
  tone: OutputSchemaLintCard["tone"];
}): React.JSX.Element | null {
  if (tone === "green") return <CheckIcon size={12} />;
  if (tone === "red") return <AlertTriangleIcon size={12} />;
  return null;
}

export function OutputSchemaScreen({
  editor,
}: {
  editor: ContextStructuralEditor;
}): React.JSX.Element {
  const card = outputSchemaLintCard(editor.outputSchemaText);
  // Narrowed on the affordance itself rather than on `locked`, so a new
  // non-editable mode fails to compile here until it says why it disables the
  // contract editor. The capture is a SECOND, independent lock: a paused
  // execution is `editable` and its banked context's contract is still settled,
  // which is the one case where the mode alone would get this wrong.
  const lockedHint =
    editor.affordance === "editable"
      ? editor.schemaFrozen === true
        ? OUTPUT_SCHEMA_DISABLED_HINT.frozen
        : null
      : OUTPUT_SCHEMA_DISABLED_HINT[editor.affordance];
  const locked = isConfigLocked(editor.affordance) || lockedHint !== null;

  return (
    <ConfigRowGroup>
      <ConfigControlRow
        rowId="schema-json"
        label="JSON schema"
        disabled={locked}
      >
        <MultilineInput
          aria-label="Output schema JSON"
          spellCheck={false}
          rows={12}
          value={editor.outputSchemaText}
          disabled={locked}
          onValueChange={editor.onOutputSchemaTextChange}
          className={cn(
            "box-border block w-full resize-y rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[9px]",
            "font-mono text-[0.72rem] leading-[1.6] whitespace-pre [tab-size:2] text-text-primary transition-[border-color] duration-150 outline-none",
            "focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-55",
            card.tone === "red" && "border-red",
          )}
        />

        <div
          data-testid="output-schema-lint"
          data-state={card.state}
          // Only a refusal interrupts: an acceptance the author just typed
          // their way into needs no announcement.
          {...(card.tone === "red" ? { role: "alert" as const } : {})}
          className={cn(
            "flex flex-col gap-[4px] rounded-sm border border-solid px-[10px] py-[8px]",
            TONE_BOX[card.tone],
          )}
        >
          <div
            className={cn(
              "flex items-center gap-[6px] font-mono text-[0.72rem] font-semibold",
              TONE_TEXT[card.tone],
            )}
          >
            <LintIcon tone={card.tone} />
            {card.title}
          </div>
          <div className="font-mono text-[0.7rem] leading-[1.5] [overflow-wrap:anywhere] text-text-secondary">
            {card.detail}
          </div>
        </div>
      </ConfigControlRow>

      {lockedHint === null ? null : (
        <ConfigControlRow
          rowId="schema-locked"
          label="Why it is locked"
          hint={lockedHint}
        />
      )}
    </ConfigRowGroup>
  );
}
