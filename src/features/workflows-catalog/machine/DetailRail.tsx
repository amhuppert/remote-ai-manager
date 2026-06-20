"use client";

import { cn } from "@/lib/ui/cn";
import type {
  MachineSpec,
  StateInfo,
  StateStatus,
} from "../machine-spec-types";

interface DetailRailProps {
  spec: MachineSpec;
  selectedStateId: string | null;
  onClearSelection: () => void;
}

const railTagBase =
  "rounded-sm border border-solid px-[8px] py-[2px] font-mono text-[0.7rem] uppercase tracking-[0.08em]";

/** Status → tag color triplet (text/bg/border). `neutral` is the violet default. */
const railTagToneClass: Record<StateStatus, string> = {
  neutral: "border-violet-dim bg-violet-glow text-violet",
  initial: "border-cyan-dim bg-cyan-glow text-cyan",
  success: "border-green-dim bg-green-glow text-green",
  warning: "border-amber-dim bg-amber-glow text-amber",
  failure: "border-red-dim bg-red-glow text-red",
};

/**
 * Right-side panel on the detail page. Two modes:
 *   • No selection — shows the machine description, file path, actor list,
 *     guard list, and action list (the "atlas" view).
 *   • A state is selected — replaces the body with that state's full info
 *     (kind, status, parent, description, invokes, entry actions, outgoing
 *     events with guards) and a "back to overview" pill at the top.
 */
export default function DetailRail({
  spec,
  selectedStateId,
  onClearSelection,
}: DetailRailProps): React.JSX.Element {
  const selected = selectedStateId
    ? spec.states.find((s) => s.id === selectedStateId)
    : undefined;

  return (
    <aside className="flex min-h-0 flex-col gap-md overflow-y-auto rounded-lg border border-solid border-border-subtle bg-bg-surface p-md max-1100:group-data-[mobile-panel=diagram]:hidden">
      {selected ? (
        <SelectedStatePane state={selected} onClear={onClearSelection} />
      ) : (
        <MachinePane spec={spec} />
      )}
    </aside>
  );
}

function MachinePane({ spec }: { spec: MachineSpec }): React.JSX.Element {
  return (
    <>
      <div className="flex flex-col gap-sm">
        <div className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
          About this workflow
        </div>
        <p className="text-[0.9rem] leading-[1.55] text-text-secondary">
          {spec.description}
        </p>
        <div className="flex flex-wrap items-center gap-sm">
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            id: {spec.machineId}
          </span>
        </div>
        <div className="flex flex-col gap-[2px] font-mono text-[0.7rem]">
          <span className="tracking-[0.08em] text-text-tertiary uppercase">
            source
          </span>
          <code className="rounded-sm bg-bg-base px-[8px] py-[4px] break-all text-cyan-dim">
            {spec.filePath}
          </code>
        </div>
      </div>

      {spec.actors.length > 0 && (
        <RailListSection title="Actors" hint="invoke.src">
          {spec.actors.map((actor) => (
            <li key={actor.name} className="flex flex-col gap-[2px]">
              <div className="font-mono text-[0.85rem] text-cyan">
                {actor.name}
              </div>
              <div className="text-[0.85rem] leading-[1.5] text-text-secondary">
                {actor.description}
              </div>
            </li>
          ))}
        </RailListSection>
      )}

      {spec.guards.length > 0 && (
        <RailListSection title="Guards" hint="conditional transitions">
          {spec.guards.map((guard) => (
            <li key={guard.name} className="flex flex-col gap-[2px]">
              <div className="font-mono text-[0.85rem] text-cyan">
                {guard.name}
              </div>
              <div className="text-[0.85rem] leading-[1.5] text-text-secondary">
                {guard.description}
              </div>
            </li>
          ))}
        </RailListSection>
      )}

      {spec.actions.length > 0 && (
        <RailListSection title="Actions" hint="side effects">
          {spec.actions.map((action) => (
            <li key={action.name} className="flex flex-col gap-[2px]">
              <div className="font-mono text-[0.85rem] text-cyan">
                {action.name}
              </div>
              <div className="text-[0.85rem] leading-[1.5] text-text-secondary">
                {action.description}
              </div>
            </li>
          ))}
        </RailListSection>
      )}

      <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle pt-md text-[0.8rem] text-text-tertiary italic">
        Click any state in the diagram to inspect it.
      </div>
    </>
  );
}

function SelectedStatePane({
  state,
  onClear,
}: {
  state: StateInfo;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-[6px] self-start rounded-sm border border-solid border-border-subtle bg-transparent px-[10px] py-[4px] font-mono text-[0.7rem] text-text-secondary transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
        onClick={onClear}
      >
        ← Back to overview
      </button>
      <div className="flex flex-col gap-sm">
        <div className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
          {state.kind} state
        </div>
        <h2 className="font-display text-[1.5rem] tracking-[-0.01em] text-text-primary">
          {state.label}
        </h2>
        <div className="flex flex-wrap items-center gap-sm">
          {state.status && (
            <span className={cn(railTagBase, railTagToneClass[state.status])}>
              {state.status}
            </span>
          )}
          {state.parentId && (
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              parent: {state.parentId}
            </span>
          )}
        </div>
        {state.description && (
          <p className="text-[0.9rem] leading-[1.55] text-text-secondary">
            {state.description}
          </p>
        )}
      </div>

      {state.invokes && state.invokes.length > 0 && (
        <RailListSection title="Invokes" hint="actor src">
          {state.invokes.map((name) => (
            <li key={name} className="flex flex-col gap-[2px]">
              <div className="font-mono text-[0.85rem] text-cyan">{name}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {state.entryActions && state.entryActions.length > 0 && (
        <RailListSection title="Entry actions">
          {state.entryActions.map((name) => (
            <li key={name} className="flex flex-col gap-[2px]">
              <div className="font-mono text-[0.85rem] text-cyan">{name}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {state.events && state.events.length > 0 && (
        <RailListSection title="Outgoing transitions">
          {state.events.map((evt, i) => (
            <li
              key={`${evt.event}-${evt.target ?? "internal"}-${i}`}
              className="flex flex-col gap-[2px]"
            >
              <div className="flex items-center gap-[6px] font-mono text-[0.85rem]">
                <span className="text-text-primary">{evt.event}</span>
                {evt.target && <span className="text-text-tertiary">→</span>}
                {evt.target && <span className="text-cyan">{evt.target}</span>}
              </div>
              {evt.guard && (
                <div className="font-mono text-[0.7rem] text-amber">
                  [{evt.guard}]
                </div>
              )}
              {evt.description && (
                <div className="text-[0.85rem] leading-[1.5] text-text-secondary">
                  {evt.description}
                </div>
              )}
            </li>
          ))}
        </RailListSection>
      )}
    </>
  );
}

function RailListSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm">
      <div className="flex items-baseline justify-between border-x-0 border-t border-b-0 border-solid border-border-subtle pt-md">
        <h3 className="font-mono text-[0.85rem] tracking-[0.08em] text-text-primary uppercase">
          {title}
        </h3>
        {hint && (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {hint}
          </span>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col gap-sm p-0">{children}</ul>
    </div>
  );
}
