"use client";

import type { MachineSpec, StateInfo } from "../machine-spec-types";

interface DetailRailProps {
  spec: MachineSpec;
  selectedStateId: string | null;
  onClearSelection: () => void;
}

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
    <aside className="workflow-rail">
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
      <div className="workflow-rail-section">
        <div className="workflow-rail-eyebrow">About this workflow</div>
        <p className="workflow-rail-desc">{spec.description}</p>
        <div className="workflow-rail-meta">
          <span className="workflow-rail-machine-id">id: {spec.machineId}</span>
        </div>
        <div className="workflow-rail-filepath">
          <span className="workflow-rail-filepath-label">source</span>
          <code>{spec.filePath}</code>
        </div>
      </div>

      {spec.actors.length > 0 && (
        <RailListSection title="Actors" hint="invoke.src">
          {spec.actors.map((actor) => (
            <li key={actor.name} className="workflow-rail-item">
              <div className="workflow-rail-item-name">{actor.name}</div>
              <div className="workflow-rail-item-desc">{actor.description}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {spec.guards.length > 0 && (
        <RailListSection title="Guards" hint="conditional transitions">
          {spec.guards.map((guard) => (
            <li key={guard.name} className="workflow-rail-item">
              <div className="workflow-rail-item-name">{guard.name}</div>
              <div className="workflow-rail-item-desc">{guard.description}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {spec.actions.length > 0 && (
        <RailListSection title="Actions" hint="side effects">
          {spec.actions.map((action) => (
            <li key={action.name} className="workflow-rail-item">
              <div className="workflow-rail-item-name">{action.name}</div>
              <div className="workflow-rail-item-desc">
                {action.description}
              </div>
            </li>
          ))}
        </RailListSection>
      )}

      <div className="workflow-rail-hint">
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
      <button type="button" className="workflow-rail-back" onClick={onClear}>
        ← Back to overview
      </button>
      <div className="workflow-rail-section">
        <div className="workflow-rail-eyebrow">{state.kind} state</div>
        <h2 className="workflow-rail-title">{state.label}</h2>
        <div className="workflow-rail-meta">
          {state.status && (
            <span
              className={`workflow-rail-tag workflow-rail-tag--${state.status}`}
            >
              {state.status}
            </span>
          )}
          {state.parentId && (
            <span className="workflow-rail-machine-id">
              parent: {state.parentId}
            </span>
          )}
        </div>
        {state.description && (
          <p className="workflow-rail-desc">{state.description}</p>
        )}
      </div>

      {state.invokes && state.invokes.length > 0 && (
        <RailListSection title="Invokes" hint="actor src">
          {state.invokes.map((name) => (
            <li key={name} className="workflow-rail-item">
              <div className="workflow-rail-item-name">{name}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {state.entryActions && state.entryActions.length > 0 && (
        <RailListSection title="Entry actions">
          {state.entryActions.map((name) => (
            <li key={name} className="workflow-rail-item">
              <div className="workflow-rail-item-name">{name}</div>
            </li>
          ))}
        </RailListSection>
      )}

      {state.events && state.events.length > 0 && (
        <RailListSection title="Outgoing transitions">
          {state.events.map((evt, i) => (
            <li
              key={`${evt.event}-${evt.target ?? "internal"}-${i}`}
              className="workflow-rail-item workflow-rail-event"
            >
              <div className="workflow-rail-event-row">
                <span className="workflow-rail-event-name">{evt.event}</span>
                {evt.target && (
                  <span className="workflow-rail-event-arrow">→</span>
                )}
                {evt.target && (
                  <span className="workflow-rail-event-target">
                    {evt.target}
                  </span>
                )}
              </div>
              {evt.guard && (
                <div className="workflow-rail-event-guard">[{evt.guard}]</div>
              )}
              {evt.description && (
                <div className="workflow-rail-item-desc">{evt.description}</div>
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
    <div className="workflow-rail-section">
      <div className="workflow-rail-section-header">
        <h3 className="workflow-rail-section-title">{title}</h3>
        {hint && <span className="workflow-rail-section-hint">{hint}</span>}
      </div>
      <ul className="workflow-rail-list">{children}</ul>
    </div>
  );
}
