"use client";

import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useComposerFocused } from "@/stores/session-detail.store";
import { gridShape } from "./grid-shape";
import PanesToolbar from "./PanesToolbar";
import Pane from "./Pane";

export interface PanesGridProps {
  workingSet: SessionActiveConversation[];
  activeId: string;
  isAtCap: boolean;
  addableConversations: SessionActiveConversation[];
  onActivate: (id: string) => void;
  onOpenFull: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: (id: string) => void;
  onExit: () => void;
}

export default function PanesGrid({
  workingSet,
  activeId,
  isAtCap,
  addableConversations,
  onActivate,
  onOpenFull,
  onClose,
  onAdd,
  onExit,
}: PanesGridProps): React.JSX.Element {
  const panes = workingSet;
  const shape = gridShape(panes.length);

  // Read the focus flag directly (focused selector per PERFORMANCE.md) rather
  // than threading it as a prop. The CSS fade is driven solely by this
  // attribute: blur reverts emphasis automatically (5.4), and because PanesGrid
  // only mounts in panes mode, composer focus has no pane effect in any
  // single-conversation layout (5.5).
  const composerFocused = useComposerFocused();

  return (
    // `group` + data-composer-focused drive the per-pane composer-focus emphasis
    // through `group-data-[composer-focused=true]:` variants on each Pane (§8.2):
    // blur reverts emphasis automatically (5.4), and because PanesGrid only
    // mounts in panes mode, composer focus has no pane effect in any
    // single-conversation layout (5.5).
    <div
      className="group flex h-full min-h-0 w-full min-w-0 flex-col"
      data-composer-focused={composerFocused ? "true" : undefined}
    >
      <PanesToolbar
        count={panes.length}
        isAtCap={isAtCap}
        addableConversations={addableConversations}
        onAdd={onAdd}
        onExit={onExit}
      />
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-[repeat(var(--cols,1),1fr)] grid-rows-[repeat(var(--rows,1),1fr)] gap-sm p-sm"
        data-shape={shape.shape}
        // The `--cols`/`--rows` custom properties are not part of TS's
        // CSSProperties type, so the cast is the established CSS-var idiom — not
        // a type bypass.
        style={
          { "--cols": shape.cols, "--rows": shape.rows } as React.CSSProperties
        }
      >
        {panes.map((c, i) => (
          <Pane
            key={c.id}
            conversation={c}
            active={c.id === activeId}
            onActivate={onActivate}
            onOpenFull={onOpenFull}
            onClose={onClose}
            // asym-5: the first three panes span 2 of 6 columns, the last two
            // span 3 (the legacy `[data-shape="asym-5"] > .pane:nth-child` rule,
            // applied as external grid placement). Other shapes auto-place.
            layoutClassName={
              shape.shape === "asym-5"
                ? i < 3
                  ? "[grid-column:span_2]"
                  : "[grid-column:span_3]"
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
