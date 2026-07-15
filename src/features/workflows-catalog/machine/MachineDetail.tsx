"use client";

import "../styles/workflows-catalog.css";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import type { MachineId, MachineSpec } from "../machine-spec-types";
import ConversationLayout from "../layouts/ConversationLayout";
import MergeLayout from "../layouts/MergeLayout";
import CommitLayout from "../layouts/CommitLayout";
import DetailRail from "./DetailRail";
import WorkflowCanvasShell from "./WorkflowCanvasShell";

interface SiblingSpec {
  id: MachineId;
  name: string;
}

interface MachineDetailProps {
  spec: MachineSpec;
  /** All workflow specs in display order (for cross-workflow navigation). */
  siblings: ReadonlyArray<SiblingSpec>;
}

interface LayoutCmpProps {
  selectedStateId: string | null;
  onSelectState: (id: string) => void;
}

const layoutByMachine: Record<
  MachineId,
  (p: LayoutCmpProps) => React.JSX.Element
> = {
  conversation: ConversationLayout,
  "smart-merge": MergeLayout,
  "smart-commit": CommitLayout,
};

type MobilePanel = "diagram" | "info";

export default function MachineDetail({
  spec,
  siblings,
}: MachineDetailProps): React.JSX.Element {
  const router = useRouter();
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("diagram");
  const Layout = layoutByMachine[spec.id];

  // Toggle selection: clicking the already-selected state clears it. Selecting
  // a state on mobile auto-flips to the info tab so the user immediately sees
  // the detail they just clicked.
  const handleSelectState = (id: string): void => {
    setSelectedStateId((current) => {
      const next = current === id ? null : id;
      if (
        next != null &&
        typeof window !== "undefined" &&
        window.innerWidth <= 1100
      ) {
        setMobilePanel("info");
      }
      return next;
    });
  };

  const { index, prev, next } = useMemo(() => {
    const i = siblings.findIndex((s) => s.id === spec.id);
    const prevSibling = i > 0 ? siblings[i - 1] : undefined;
    const nextSibling =
      i >= 0 && i < siblings.length - 1 ? siblings[i + 1] : undefined;
    return {
      index: i + 1,
      prev: prevSibling
        ? { name: prevSibling.name, href: `/workflows/${prevSibling.id}` }
        : undefined,
      next: nextSibling
        ? { name: nextSibling.name, href: `/workflows/${nextSibling.id}` }
        : undefined,
    };
  }, [siblings, spec.id]);

  const goPrev = useCallback(() => {
    if (prev) {
      setSelectedStateId(null);
      router.push(prev.href);
    }
  }, [prev, router]);

  const goNext = useCallback(() => {
    if (next) {
      setSelectedStateId(null);
      router.push(next.href);
    }
  }, [next, router]);

  return (
    <div
      className="app group"
      data-page="workflows"
      data-page-variant="detail"
      data-mobile-panel={mobilePanel}
    >
      <Topbar
        page="workflows"
        breadcrumbs={[
          { label: "workflows", href: "/workflows" },
          { label: spec.name },
        ]}
      />
      <div
        className="hidden gap-[2px] rounded-md border border-solid border-border-default bg-bg-surface p-[3px] max-768:mx-md max-768:self-stretch max-1100:mx-lg max-1100:mt-sm max-1100:flex max-1100:self-center"
        role="tablist"
        aria-label="Workflow view"
      >
        <PanelTab
          active={mobilePanel === "diagram"}
          onClick={() => setMobilePanel("diagram")}
        >
          Diagram
        </PanelTab>
        <PanelTab
          active={mobilePanel === "info"}
          onClick={() => setMobilePanel("info")}
        >
          Info
        </PanelTab>
      </div>
      <main className="main workflow-detail-main">
        <WorkflowCanvasShell
          title={spec.name}
          character={spec.character}
          index={index}
          total={siblings.length}
          prev={prev}
          next={next}
          onPrev={goPrev}
          onNext={goNext}
          resetKey={spec.id}
        >
          <Layout
            selectedStateId={selectedStateId}
            onSelectState={handleSelectState}
          />
        </WorkflowCanvasShell>
        <DetailRail
          spec={spec}
          selectedStateId={selectedStateId}
          onClearSelection={() => setSelectedStateId(null)}
        />
      </main>
    </div>
  );
}

/**
 * Mobile diagram/info panel switch. Replicates the canonical tab recipe as
 * wave-local utilities rather than the shared `Tabs` primitive: this switcher's
 * mobile parity requires per-tab `justify-content: center`, a 44px touch
 * `min-height`, and a 0.78rem `font-size` (legacy `.workflow-mobile-tabs .cc-tab`
 * overrides), none of which the appearance-locked `Tab` primitive can carry —
 * and editing the shared primitive is out of this wave's scope. Active beats
 * hover via mutually-exclusive `data-active` gating (the Tabs idiom).
 */
function PanelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      onClick={onClick}
      className="flex min-h-[28px] cursor-pointer items-center gap-[4px] rounded-sm border-0 bg-transparent px-[10px] py-[5px] font-mono text-[0.72rem] font-medium tracking-[0.05em] whitespace-nowrap text-text-secondary uppercase transition-all duration-150 ease-[ease] data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse max-768:min-h-[44px] max-768:grow max-768:text-[0.78rem] max-1100:min-w-[90px] max-1100:justify-center"
    >
      {children}
    </button>
  );
}
