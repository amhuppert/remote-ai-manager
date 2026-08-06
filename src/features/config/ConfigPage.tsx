"use client";

import { useState } from "react";
import Topbar from "@/components/Topbar";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
import { cn } from "@/lib/ui/cn";
import { useFullConfigQuery } from "@/lib/config/queries";
import { useUpdateConfigMutation } from "@/lib/config/mutations";
import { useValidationCommandOptions } from "@/lib/validation/queries";
import { ConfigSaveBar } from "./components/ConfigSaveBar";
import { SEEDED_WORKFLOW_DEFAULTS } from "./form-state";
import { BackendsSection } from "./sections/BackendsSection";
import { CapabilitiesSection } from "./sections/CapabilitiesSection";
import { CompactionSection } from "./sections/CompactionSection";
import { GeneralSection } from "./sections/GeneralSection";
import { LimitsSection } from "./sections/LimitsSection";
import { NamingSection } from "./sections/NamingSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { WorkflowSection } from "./sections/WorkflowSection";
import { useConfigForm } from "./use-config-form";

export { SEEDED_WORKFLOW_DEFAULTS };

type ConfigNavSection =
  | "general"
  | "capabilities"
  | "backends"
  | "workflow"
  | "compaction"
  | "naming"
  | "limits"
  | "notifications";

const CONFIG_NAV: Array<{ id: ConfigNavSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "backends", label: "Agent backends" },
  { id: "capabilities", label: "Capabilities" },
  { id: "workflow", label: "Workflow defaults" },
  { id: "compaction", label: "Compaction" },
  { id: "naming", label: "Naming" },
  { id: "limits", label: "Limits & timeouts" },
  { id: "notifications", label: "Notifications" },
];

// `appearance-none border-none` neutralizes the UA button chrome (a `2px outset`
// bevel) so the flat, token-driven appearance below is what renders; the active
// accent is the inset cyan box-shadow applied per-state, not a border.
const NAV_ITEM_BASE =
  "flex items-center gap-[8px] w-full min-h-[34px] px-[10px] py-[8px] appearance-none border-none rounded-sm font-mono text-[0.76rem] text-left whitespace-nowrap cursor-pointer transition-all duration-150 ease-[ease] max-900:flex-[0_0_auto] max-900:w-auto max-768:min-h-[var(--touch-target-min)] max-768:px-[16px] max-768:py-[10px]";

// The config route's main region: the shell's flex-1 scroll box (flex-1/w-full/
// min-h-0) with the shared fadeIn page-transition, run full-bleed with no padding,
// clipped, on the base background. Authored as utilities so the route owns its own
// layout rather than a feature-CSS override of the shared `.main`.
const MAIN_CLASS =
  "flex-1 w-full min-h-0 overflow-hidden p-0 bg-bg-base animate-[fadeIn_0.2s_ease]";

const CONTENT_CLASS =
  "p-2xl max-768:pb-[calc(var(--spacing-3xl)+var(--touch-target-min))]";

export default function ConfigPage(): React.JSX.Element {
  const configQuery = useFullConfigQuery();
  const mutation = useUpdateConfigMutation();
  const {
    controller,
    dirtyCount,
    invalidCount,
    buildSavePayload,
    applySaved,
    revert,
  } = useConfigForm(configQuery.data);
  // Global scope: the union of every project's registry, since a global
  // default may reference any project's command.
  const commandOptions = useValidationCommandOptions(null);
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
        <TabsRoot
          orientation="vertical"
          value={activeSection}
          onValueChange={(value) => setActiveSection(value as ConfigNavSection)}
          layoutClassName="[display:contents]"
        >
          <div
            className="grid h-full min-h-0 grid-cols-[248px_minmax(0,1fr)] bg-bg-base max-900:grid-cols-[1fr]"
            data-active-section={activeSection}
          >
            <aside className="overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-void px-lg py-xl max-900:border-r-0 max-900:border-b max-900:p-md">
              <TabsList asChild aria-label="Settings">
                <nav className="flex flex-col gap-[2px] max-900:flex-row max-900:overflow-x-auto">
                  {CONFIG_NAV.map((item) => (
                    <TabsTrigger asChild key={item.id} value={item.id}>
                      <button
                        type="button"
                        className={cn(
                          NAV_ITEM_BASE,
                          "bg-transparent text-text-secondary hover:bg-bg-base hover:text-text-primary",
                          "data-[state=active]:bg-bg-raised data-[state=active]:text-cyan data-[state=active]:shadow-[inset_2px_0_0_var(--cyan)] data-[state=active]:hover:bg-bg-raised data-[state=active]:hover:text-cyan",
                          "outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]",
                        )}
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
                    </TabsTrigger>
                  ))}
                </nav>
              </TabsList>
            </aside>
            <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-base">
              <TabsContent
                value="general"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <GeneralSection controller={controller} />
                </div>
              </TabsContent>
              <TabsContent
                value="capabilities"
                layoutClassName="min-h-0 flex-auto overflow-hidden"
              >
                <div className="grid h-full min-h-0">
                  <CapabilitiesSection />
                </div>
              </TabsContent>
              <TabsContent
                value="backends"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <BackendsSection controller={controller} />
                </div>
              </TabsContent>
              <TabsContent
                value="workflow"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <WorkflowSection
                    controller={controller}
                    commandOptions={commandOptions}
                  />
                </div>
              </TabsContent>
              <TabsContent
                value="compaction"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <CompactionSection controller={controller} />
                </div>
              </TabsContent>
              <TabsContent
                value="naming"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <NamingSection controller={controller} />
                </div>
              </TabsContent>
              <TabsContent
                value="limits"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <LimitsSection controller={controller} />
                </div>
              </TabsContent>
              <TabsContent
                value="notifications"
                layoutClassName="min-h-0 flex-auto overflow-y-auto"
              >
                <div className={CONTENT_CLASS}>
                  <NotificationsSection controller={controller} />
                </div>
              </TabsContent>
              {!contentIsCapabilities ? (
                <ConfigSaveBar
                  dirtyCount={dirtyCount}
                  invalidCount={invalidCount}
                  saving={mutation.isPending}
                  onRevert={revert}
                  onSave={handleSave}
                />
              ) : null}
            </div>
          </div>
        </TabsRoot>
      </main>
    </div>
  );
}
