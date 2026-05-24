"use client";

import "../styles/workflows-catalog.css";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import type { MachineId, MachineSpec } from "../machine-spec-types";
import ConversationLayout from "../layouts/ConversationLayout";
import MergeLayout from "../layouts/MergeLayout";
import CommitLayout from "../layouts/CommitLayout";
import OptimisticLayout from "../layouts/OptimisticLayout";
import RetryLayout from "../layouts/RetryLayout";
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
  optimistic: OptimisticLayout,
  retry: RetryLayout,
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
      className="app"
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
        className="cc-tabs workflow-mobile-tabs"
        role="tablist"
        aria-label="Workflow view"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mobilePanel === "diagram"}
          className={`cc-tab${mobilePanel === "diagram" ? " active" : ""}`}
          onClick={() => setMobilePanel("diagram")}
        >
          Diagram
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePanel === "info"}
          className={`cc-tab${mobilePanel === "info" ? " active" : ""}`}
          onClick={() => setMobilePanel("info")}
        >
          Info
        </button>
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
