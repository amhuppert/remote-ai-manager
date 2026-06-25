"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/Button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/Popover";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { FilterToken } from "../components/filter-tokens";

export interface SessionsFilterPopoverProps {
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  sessions: SessionListItem[];
}

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
 * Status / target / include-archived toggles for the sessions panel over the
 * Radix-backed `Popover` primitive. Radix owns the open/close, outside-click and
 * Escape dismissal, focus management, and `useOverlayScope` registration —
 * replacing the previous bespoke `open` state + `mousedown` outside-click
 * listener. The options are multi-select `aria-pressed` toggle buttons (toggling
 * one mutates the shared `tokens` array the composer's filter mode writes, so
 * both surfaces stay in sync); a toggle does not close the panel. Radix's
 * `PopoverContent` is `role="dialog"` but supplies no accessible name, so an
 * explicit `aria-label` names the panel.
 */
export default function SessionsFilterPopover({
  tokens,
  onTokensChange,
  sessions,
}: SessionsFilterPopoverProps): React.JSX.Element {
  const statuses = useMemo(
    () => [...new Set(sessions.map((s) => s.derivedStatus))].sort(),
    [sessions],
  );
  const targets = useMemo(
    () => [...new Set(sessions.map((s) => s.targetBranch))].sort(),
    [sessions],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" touch>
          Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        layoutClassName="w-[220px]"
        aria-label="Session filters"
      >
        <div className="flex flex-col gap-sm">
          <div>
            <div className={GROUP_LABEL_CLASS}>Status</div>
            <div className="flex flex-wrap gap-xs">
              {statuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={isActive(tokens, "status", status)}
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
                  aria-pressed={isActive(tokens, "target", target)}
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
                aria-pressed={isActive(tokens, "archived", "include")}
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
      </PopoverContent>
    </Popover>
  );
}
