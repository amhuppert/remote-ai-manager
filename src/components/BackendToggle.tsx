"use client";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendCatalogEntry } from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { cn } from "@/lib/ui/cn";

interface BackendToggleProps {
  value: AgentBackendId;
  onChange(backend: AgentBackendId): void;
  disabled?: boolean;
  readOnly?: boolean;
  /**
   * Per-option refusal — the disabled-with-reason convention `McpConfigButton`
   * already uses, narrowed from one control-wide `disabledTooltip` to one
   * reason per option. Returning null leaves the option selectable.
   *
   * Asked per catalog entry rather than supplied as a backend-keyed map so the
   * answer comes from the entry the toggle is rendering — the live catalog —
   * and no call site has to enumerate backend ids. Facet-gated surfaces (task,
   * workflow role, collaboration) pass `backendFacetRefusal`, so an option a
   * surface cannot dispatch stays visible and explains itself instead of
   * disappearing or accepting a selection its API would refuse (spec D13).
   */
  disabledReason?: (entry: BackendCatalogEntry) => string | null;
  /**
   * Opt-in mobile touch sizing: 44px below 768px. Opt-in because 36px is the
   * session spine's density, and the two workflow pages are the surfaces held
   * to the 44px minimum.
   */
  touch?: boolean;
}

// `backend-toggle`, `backend-toggle-btn`, and `backend-toggle-badge` are
// retained purely as test hooks (UnifiedComposer / project-cockpit-flows /
// PromptDesktopToolbar tests query them); their own appearance is utilities.
const btnBase =
  "backend-toggle-btn h-full rounded-[var(--radius-xs)] border-0 bg-transparent px-sm font-mono text-[0.72rem] transition-all duration-150 ease-[ease]";

const btnClass = cn(
  btnBase,
  "cursor-pointer",
  // Inactive: tertiary text, hover lifts to a raised surface. Gated on
  // data-active=false so an active button keeps its accent colour on hover
  // (the legacy `.active[data-backend]` selector outranked `:hover`).
  "data-[active=false]:text-text-tertiary",
  "data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-secondary",
  // Active: agent-identity accent, keyed by the catalog's design-system tone.
  // A closed allowlist because Tailwind cannot generate a class from a runtime
  // token — a registered tone missing here renders the active option unstyled,
  // which BackendToggle.test.tsx asserts against the catalog.
  "data-[active=true]:data-[tone=cyan]:bg-cyan-glow data-[active=true]:data-[tone=cyan]:text-cyan",
  "data-[active=true]:data-[tone=violet]:bg-violet-glow data-[active=true]:data-[tone=violet]:text-violet",
  "data-[active=true]:data-[tone=amber]:bg-amber-glow data-[active=true]:data-[tone=amber]:text-amber",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
);

/**
 * A refused option stays focusable and hoverable via `aria-disabled` rather
 * than the `disabled` attribute: the reason is the point of the affordance, and
 * a natively disabled button shows no tooltip and takes no focus, so the reason
 * would reach neither a pointer nor a screen reader.
 */
const refusedBtnClass = cn(
  btnBase,
  "cursor-not-allowed text-text-tertiary opacity-40",
);

const touchTrackClass = "max-768:h-[44px]";
// The track's padding and border leave each segment short of 44px, so the
// pointer target is an invisible box the full height of the track. It grows
// only vertically — segments sit side by side, and a wider area would reach
// into the neighbouring backend.
const touchBtnClass =
  "max-768:relative max-768:min-w-[44px] max-768:px-md max-768:after:absolute max-768:after:top-1/2 max-768:after:left-0 max-768:after:h-[44px] max-768:after:w-full max-768:after:-translate-y-1/2 max-768:after:content-['']";

export default function BackendToggle({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  disabledReason,
  touch = false,
}: BackendToggleProps): React.JSX.Element {
  const { data: backends } = useBackendCatalogQuery();

  if (readOnly) {
    const entry = backends.find((b) => b.id === value);
    if (!entry) {
      return (
        <span
          className={cn(
            "backend-toggle-badge flex h-[36px] shrink-0 items-center rounded-md border border-solid border-amber-dim bg-bg-surface px-[12px] font-mono text-[0.72rem] text-amber",
            touch && touchTrackClass,
          )}
          data-backend-unknown="true"
          title={`Unknown agent backend: ${value}`}
        >
          {value} (unknown)
        </span>
      );
    }
    return (
      <span
        className={cn(
          "backend-toggle-badge flex h-[36px] shrink-0 items-center rounded-md border border-solid border-border-default bg-bg-surface px-[12px] font-mono text-[0.72rem] text-text-secondary",
          touch && touchTrackClass,
        )}
      >
        {entry.label}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "backend-toggle flex h-[36px] shrink-0 items-center gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-surface p-[2px]",
        touch && touchTrackClass,
      )}
    >
      {backends.map((b) => {
        const reason = disabledReason?.(b) ?? null;
        if (reason !== null) {
          const label = `${b.label} — ${reason}`;
          return (
            <button
              key={b.id}
              type="button"
              className={cn(refusedBtnClass, touch && touchBtnClass)}
              data-backend={b.id}
              data-tone={b.toneToken}
              data-active={false}
              aria-disabled="true"
              title={label}
              aria-label={label}
              // aria-disabled does not stop the click the way `disabled` would,
              // so the refusal is enforced here rather than implied.
              onClick={() => undefined}
            >
              {b.label}
            </button>
          );
        }
        return (
          <button
            key={b.id}
            type="button"
            className={cn(btnClass, touch && touchBtnClass)}
            data-backend={b.id}
            data-tone={b.toneToken}
            data-active={b.id === value}
            onClick={() => onChange(b.id)}
            disabled={disabled}
          >
            {b.label}
          </button>
        );
      })}
    </div>
  );
}
