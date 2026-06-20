"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { FilterToken } from "../components/filter-tokens";

export interface SessionsFilterPopoverProps {
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  sessions: SessionListItem[];
}

// The popover menu shadow uses the design-system popovers/menus black drop
// shadow, exposed as the `shadow-menu` token utility (theme.css → --shadow-menu).
const MENU_CLASS =
  "absolute right-0 top-[calc(100%+var(--space-xs))] z-sticky min-w-[220px] p-sm " +
  "bg-bg-elevated border border-solid border-border-default rounded-md " +
  "shadow-menu flex flex-col gap-sm";

const GROUP_LABEL_CLASS =
  "font-mono text-[0.66rem] font-semibold tracking-[0.08em] uppercase text-text-tertiary";

const OPT_CLASS =
  "px-sm py-2xs rounded-sm border border-solid border-border-subtle bg-bg-surface " +
  "text-text-secondary font-mono text-[0.72rem] cursor-pointer " +
  "data-[on=true]:border-cyan data-[on=true]:text-cyan data-[on=true]:bg-cyan-glow";

function toggleToken(
  tokens: FilterToken[],
  candidate: FilterToken,
): FilterToken[] {
  const active = tokens.some(
    (t) => t.cat === candidate.cat && t.value === candidate.value,
  );
  const withoutCat = tokens.filter((t) => t.cat !== candidate.cat);
  return active ? withoutCat : [...withoutCat, candidate];
}

function isActive(
  tokens: FilterToken[],
  cat: FilterToken["cat"],
  value: string,
): boolean {
  return tokens.some((t) => t.cat === cat && t.value === value);
}

/**
 * Status / target / include-archived toggles for the sessions panel, bound to
 * the shared filter-token state. Toggling a value mutates the same `tokens`
 * array the composer's filter mode writes, so both surfaces stay in sync.
 */
export default function SessionsFilterPopover({
  tokens,
  onTokensChange,
  sessions,
}: SessionsFilterPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const statuses = useMemo(
    () => [...new Set(sessions.map((s) => s.derivedStatus))].sort(),
    [sessions],
  );
  const targets = useMemo(
    () => [...new Set(sessions.map((s) => s.targetBranch))].sort(),
    [sessions],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        touch
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Filter
      </Button>
      {open && (
        <div className={MENU_CLASS} role="menu">
          <div>
            <div className={GROUP_LABEL_CLASS}>Status</div>
            <div className="flex flex-wrap gap-xs">
              {statuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isActive(tokens, "status", status)}
                  data-on={isActive(tokens, "status", status)}
                  className={OPT_CLASS}
                  onClick={() =>
                    onTokensChange(
                      toggleToken(tokens, {
                        cat: "status",
                        key: "is",
                        value: status,
                      }),
                    )
                  }
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={GROUP_LABEL_CLASS}>Target</div>
            <div className="flex flex-wrap gap-xs">
              {targets.map((target) => (
                <button
                  key={target}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isActive(tokens, "target", target)}
                  data-on={isActive(tokens, "target", target)}
                  className={OPT_CLASS}
                  onClick={() =>
                    onTokensChange(
                      toggleToken(tokens, {
                        cat: "target",
                        key: "target",
                        value: target,
                      }),
                    )
                  }
                >
                  {target}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={GROUP_LABEL_CLASS}>Archived</div>
            <div className="flex flex-wrap gap-xs">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isActive(tokens, "archived", "include")}
                data-on={isActive(tokens, "archived", "include")}
                className={OPT_CLASS}
                onClick={() =>
                  onTokensChange(
                    toggleToken(tokens, {
                      cat: "archived",
                      key: "include",
                      value: "include",
                    }),
                  )
                }
              >
                Include archived
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
