"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { FilterToken } from "../components/filter-tokens";

export interface SessionsFilterPopoverProps {
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  sessions: SessionListItem[];
}

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
    <div className="plc-filter-pop" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Filter
      </button>
      {open && (
        <div className="plc-filter-pop-menu" role="menu">
          <div>
            <div className="plc-filter-group-label">Status</div>
            <div className="plc-filter-options">
              {statuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isActive(tokens, "status", status)}
                  data-on={isActive(tokens, "status", status)}
                  className="plc-filter-opt"
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
            <div className="plc-filter-group-label">Target</div>
            <div className="plc-filter-options">
              {targets.map((target) => (
                <button
                  key={target}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isActive(tokens, "target", target)}
                  data-on={isActive(tokens, "target", target)}
                  className="plc-filter-opt"
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
            <div className="plc-filter-group-label">Archived</div>
            <div className="plc-filter-options">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isActive(tokens, "archived", "include")}
                data-on={isActive(tokens, "archived", "include")}
                className="plc-filter-opt"
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
