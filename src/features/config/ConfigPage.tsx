"use client";

import { useState } from "react";
import Topbar from "@/components/Topbar";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { cn } from "@/lib/ui/cn";
import { useFullConfigQuery } from "@/lib/config/queries";
import { useUpdateConfigMutation } from "@/lib/config/mutations";
import { ConfigSaveBar } from "./components/ConfigSaveBar";
import { SEEDED_WORKFLOW_DEFAULTS } from "./form-state";
import { BackendsSection } from "./sections/BackendsSection";
import { CapabilitiesSection } from "./sections/CapabilitiesSection";
import { DefaultsSection } from "./sections/DefaultsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { LimitsSection } from "./sections/LimitsSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { WorkflowSection } from "./sections/WorkflowSection";
import { useConfigForm } from "./use-config-form";

export { SEEDED_WORKFLOW_DEFAULTS };

type ConfigNavSection =
  | "general"
  | "defaults"
  | "capabilities"
  | "backends"
  | "workflow"
  | "limits"
  | "notifications";

const CONFIG_NAV: Array<{ id: ConfigNavSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "defaults", label: "Agent defaults" },
  { id: "capabilities", label: "Capabilities" },
  { id: "backends", label: "Backends" },
  { id: "workflow", label: "Workflow defaults" },
  { id: "limits", label: "Limits & timeouts" },
  { id: "notifications", label: "Notifications" },
];

const NAV_ITEM_BASE =
  "flex items-center gap-[8px] w-full min-h-[34px] px-[10px] py-[8px] rounded-sm font-mono text-[0.76rem] text-left whitespace-nowrap cursor-pointer transition-all duration-150 ease-[ease] max-900:flex-[0_0_auto] max-900:w-auto";

// The config route's main region: the shell's flex-1 scroll box (flex-1/w-full/
// min-h-0) with the shared fadeIn page-transition, run full-bleed with no padding,
// clipped, on the base background. Authored as utilities so the route owns its own
// layout rather than a feature-CSS override of the shared `.main`.
const MAIN_CLASS =
  "flex-1 w-full min-h-0 overflow-hidden p-0 bg-bg-base animate-[fadeIn_0.2s_ease]";

export default function ConfigPage(): React.JSX.Element {
  const configQuery = useFullConfigQuery();
  const mutation = useUpdateConfigMutation();
  const { controller, dirtyCount, buildSavePayload, applySaved, revert } =
    useConfigForm(configQuery.data);
  const [activeSection, setActiveSection] =
    useState<ConfigNavSection>("general");

  if (configQuery.isPending) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className={MAIN_CLASS}>
          <EmptyState>
            <EmptyStateTitle>Loading configuration...</EmptyStateTitle>
          </EmptyState>
        </main>
      </div>
    );
  }

  if (configQuery.isError || !controller) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className={MAIN_CLASS}>
          <EmptyState>
            <EmptyStateTitle>Failed to load configuration</EmptyStateTitle>
            <EmptyStateDesc>
              {configQuery.error?.message ?? "Unknown error"}
            </EmptyStateDesc>
          </EmptyState>
        </main>
      </div>
    );
  }

  const handleSave = () => {
    const payload = buildSavePayload();
    if (!payload) return;
    mutation.mutate(payload, {
      onSuccess: (data) => applySaved(data),
    });
  };

  const contentIsCapabilities = activeSection === "capabilities";

  return (
    <div className="app" data-page="config">
      <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
      <main className={MAIN_CLASS}>
        <div
          className="grid h-full min-h-0 grid-cols-[248px_minmax(0,1fr)] bg-bg-base max-900:grid-cols-[1fr]"
          data-active-section={activeSection}
        >
          <aside className="overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-void px-lg py-xl max-900:border-r-0 max-900:border-b max-900:p-md">
            <nav
              className="flex flex-col gap-[2px] max-900:flex-row max-900:overflow-x-auto"
              aria-label="Settings"
            >
              {CONFIG_NAV.map((item) => {
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={cn(
                      NAV_ITEM_BASE,
                      isActive
                        ? "bg-bg-raised text-cyan shadow-[inset_2px_0_0_var(--cyan)]"
                        : "bg-transparent text-text-secondary hover:bg-bg-base hover:text-text-primary",
                    )}
                    onClick={() => setActiveSection(item.id)}
                  >
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
                      {item.label}
                    </span>
                    {item.id === "capabilities" ? (
                      <span className="ml-auto rounded-full bg-cyan-glow px-[6px] py-px text-[0.7rem] tracking-[0.05em] text-cyan">
                        cascading
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </aside>
          <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-base">
            <div
              className={cn(
                "min-h-0 flex-auto",
                contentIsCapabilities
                  ? "grid overflow-hidden"
                  : "overflow-y-auto p-2xl",
              )}
            >
              {activeSection === "general" && (
                <GeneralSection controller={controller} />
              )}
              {activeSection === "defaults" && (
                <DefaultsSection controller={controller} />
              )}
              {activeSection === "capabilities" && <CapabilitiesSection />}
              {activeSection === "backends" && (
                <BackendsSection controller={controller} />
              )}
              {activeSection === "workflow" && (
                <WorkflowSection controller={controller} />
              )}
              {activeSection === "limits" && (
                <LimitsSection controller={controller} />
              )}
              {activeSection === "notifications" && (
                <NotificationsSection controller={controller} />
              )}
            </div>
            {!contentIsCapabilities ? (
              <ConfigSaveBar
                dirtyCount={dirtyCount}
                saving={mutation.isPending}
                onRevert={revert}
                onSave={handleSave}
              />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
