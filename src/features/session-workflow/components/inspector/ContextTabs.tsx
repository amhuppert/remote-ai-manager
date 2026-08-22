"use client";

import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
import { cn } from "@/lib/ui/cn";
import { inspectorBodyClass } from "./chrome";
import type { InspectorTab } from "./navigation";

/**
 * The context inspector's tab shell — Tasks · Config · History (design E1).
 *
 * Only the shell: it owns the tablist, its keyboard semantics and the one
 * scrolling body every tab renders into. What each tab shows is the caller's,
 * which is what lets the three tab surfaces be owned by different modules
 * without any of them re-deciding the rail's layout.
 */
export default function ContextTabs({
  activeTab,
  onTabChange,
  above,
  tasks,
  config,
  history,
}: {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  /** Rendered inside the body above the tab panels — halts, parked questions. */
  above?: React.ReactNode;
  tasks: React.ReactNode;
  config: React.ReactNode;
  history: React.ReactNode;
}): React.JSX.Element {
  return (
    <TabsRoot
      value={activeTab}
      onValueChange={(value) => onTabChange(value as InspectorTab)}
      layoutClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-[8px]">
        <TabsList aria-label="Context inspector sections">
          {/* §12: below 768px this strip is the Inspector panel's own
              navigation, so its tabs carry the page's 44px touch minimum. */}
          <TabsTrigger value="tasks" touch>
            Tasks
          </TabsTrigger>
          <TabsTrigger value="config" touch>
            Config
          </TabsTrigger>
          <TabsTrigger value="history" touch>
            History
          </TabsTrigger>
        </TabsList>
      </div>

      <div className={cn(inspectorBodyClass, "wb-inspector-body", "min-h-0")}>
        {above}
        <TabsContent value="tasks">{tasks}</TabsContent>
        <TabsContent value="config">{config}</TabsContent>
        <TabsContent value="history">{history}</TabsContent>
      </div>
    </TabsRoot>
  );
}
