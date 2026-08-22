"use client";

import type {
  CharterInvariant,
  PersistedSourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { sourceScopeContextIds } from "@/lib/workflows/charter-schemas";
import { isConfigLocked } from "./affordance";
import {
  ConfigChecklist,
  ConfigItemList,
  ConfigTextArea,
  type ConfigChecklistOption,
  type ConfigListItem,
} from "./ConfigControls";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import { moveItem, removeItem } from "./ordered-edits";
import type { WorkflowStructuralEditor } from "./structural-editor";
import { chipPart, textPart, type ConfigValuePart } from "./value-parts";

/**
 * Charter — the cross-cutting rules every context is held to, and the ranked
 * sources those rules are read against (Config Panel `charterRows()`).
 *
 * Applicability is expressed by ABSENCE: a charter entry with no `appliesTo` is
 * global, and `charterScopeSchema` refuses an empty `contextIds`. So unchecking
 * the last context here must delete the field rather than leave `[]` — the one
 * rule this screen has to get right, and the reason scope is edited through a
 * single helper below.
 */

const INVARIANTS_HINT =
  "Rendered into every scoped context's prompt. An unscoped invariant is global.";

const SOURCES_HINT =
  "Ranked. Each context's prompt renders only the sources scoped to it; an unscoped source is global.";

/**
 * Apply a scope edit, spelling "global" as the absent field.
 *
 * Returns a value for spreading: `undefined` on the key is not the same as the
 * key being missing under `exactOptionalPropertyTypes`, so the caller composes
 * the object rather than assigning `appliesTo: undefined`.
 */
function sourceWithScope(
  source: PersistedSourceOfTruth,
  contextIds: readonly string[],
): PersistedSourceOfTruth {
  // Destructured out rather than overwritten: an explicit `appliesTo: undefined`
  // is a PRESENT key, and a legacy prose scope would survive a spread.
  const { appliesTo: _dropped, ...rest } = source;
  return contextIds.length === 0
    ? rest
    : { ...rest, appliesTo: { contextIds: [...contextIds] } };
}

/** The next free `inv-N`, so a removed id is never handed to a new invariant. */
function nextInvariantId(existing: readonly CharterInvariant[]): string {
  const taken = new Set(existing.map((each) => each.id));
  let index = existing.length + 1;
  while (taken.has(`inv-${index}`)) index += 1;
  return `inv-${index}`;
}

function scopeChip(contextIds: readonly string[] | null): ConfigValuePart {
  if (contextIds === null || contextIds.length === 0) {
    return chipPart("global");
  }
  return chipPart(`${contextIds.length} ctx`, "cyan");
}

export function CharterScreen({
  editor,
}: {
  editor: WorkflowStructuralEditor;
}): React.JSX.Element {
  const locked = isConfigLocked(editor.affordance);
  const { charter, contexts } = editor;
  const invariants = charter.invariants ?? [];
  const sources = charter.sourcesOfTruth;

  function editCharter(patch: Partial<WorkflowCharter>): void {
    // Spread the whole charter: mission, conventions, non-goals, vocabulary,
    // test strategy and known ambiguities are authored elsewhere and have to
    // survive every edit here verbatim (README §6).
    editor.onCharterChange({ ...charter, ...patch });
  }

  function editInvariants(next: readonly CharterInvariant[]): void {
    editCharter({ invariants: [...next] });
  }

  function editSources(next: readonly PersistedSourceOfTruth[]): void {
    editCharter({ sourcesOfTruth: [...next] });
  }

  function scopeOptions(
    source: PersistedSourceOfTruth,
    index: number,
  ): ConfigChecklistOption[] {
    // A legacy prose `appliesTo` carries no context ids to filter on and reads
    // as global, exactly as the engine renders it.
    const scoped = sourceScopeContextIds(source) ?? [];
    return contexts.map((context) => ({
      id: context.id,
      label: context.id,
      description: context.title,
      ariaLabel: `Scope ${source.id} to ${context.id}`,
      checked: scoped.includes(context.id),
      onToggle: (next) => {
        const contextIds = next
          ? [...scoped, context.id]
          : scoped.filter((each) => each !== context.id);
        editSources(
          sources.map((each, at) =>
            at === index ? sourceWithScope(each, contextIds) : each,
          ),
        );
      },
    }));
  }

  const invariantItems: ConfigListItem[] = invariants.map(
    (invariant, index) => ({
      id: invariant.id,
      title: invariant.id,
      chips: [scopeChip(invariant.appliesTo?.contextIds ?? null)],
      onRemove: () => editInvariants(removeItem(invariants, index)),
      onMoveUp:
        index === 0
          ? undefined
          : () => editInvariants(moveItem(invariants, index, index - 1)),
      onMoveDown:
        index === invariants.length - 1
          ? undefined
          : () => editInvariants(moveItem(invariants, index, index + 1)),
      children: (
        <ConfigTextArea
          value={invariant.statement}
          onChange={(statement) =>
            editInvariants(
              invariants.map((each, at) =>
                at === index ? { ...each, statement } : each,
              ),
            )
          }
          ariaLabel={`Statement for ${invariant.id}`}
          rows={2}
          placeholder="What every scoped context must hold to"
          disabled={locked}
        />
      ),
    }),
  );

  const sourceItems: ConfigListItem[] = sources.map((source, index) => ({
    id: source.id,
    title: source.id,
    chips: [chipPart(`rank ${source.rank}`), chipPart(source.type)],
    meta: `${source.label} — ${source.locator}`,
    children: (
      <ConfigChecklist
        options={scopeOptions(source, index)}
        disabled={locked}
      />
    ),
  }));

  return (
    <>
      <ConfigRowGroup label="Invariants">
        <ConfigControlRow
          rowId="charter-invariants"
          label="Invariants"
          hint={INVARIANTS_HINT}
          disabled={locked}
        >
          {invariants.length === 0 ? (
            <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
              No invariants declared.
            </p>
          ) : null}
          <ConfigItemList
            items={invariantItems}
            disabled={locked}
            {...(locked
              ? {}
              : {
                  addLabel: "Add invariant",
                  onAdd: () =>
                    editInvariants([
                      ...invariants,
                      { id: nextInvariantId(invariants), statement: "" },
                    ]),
                })}
          />
        </ConfigControlRow>
      </ConfigRowGroup>

      <ConfigRowGroup label="Sources of truth">
        <ConfigControlRow
          rowId="charter-sources"
          label="Sources of truth"
          hint={SOURCES_HINT}
          parts={[textPart(`${sources.length} ranked`, "dim")]}
          disabled={locked}
        >
          <ConfigItemList items={sourceItems} disabled={locked} />
        </ConfigControlRow>
      </ConfigRowGroup>
    </>
  );
}
