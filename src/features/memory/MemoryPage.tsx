"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import MemoryLibraryPanel, {
  type MemoryQueue,
} from "@/components/memory/MemoryLibraryPanel";
import { useMemoryNavigation } from "@/components/memory/use-memory-navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { useProjectsQuery } from "@/lib/projects/queries";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("memory-page");

export default function MemoryPage(): React.JSX.Element {
  return (
    <Suspense>
      <MemoryRoute />
    </Suspense>
  );
}

function MemoryRoute(): React.JSX.Element {
  const params = useSearchParams();
  return (
    <MemoryScreen
      key={params.get("project") ?? "global"}
      initialLocation={params.toString()}
    />
  );
}

export function MemoryScreen({
  initialLocation = "",
}: {
  initialLocation?: string;
}): React.JSX.Element {
  const [location, setLocation] = useState(initialLocation);
  const params = new URLSearchParams(location);
  const projectName = params.get("project");
  const projects = useProjectsQuery();
  const navigation = useMemoryNavigation();
  const queue = params.get("queue");
  const initialQueue: MemoryQueue =
    queue === "review" ||
    queue === "proposed" ||
    queue === "archived" ||
    queue === "candidates" ||
    queue === "attention"
      ? queue
      : "active";
  function updateLocation(values: Record<string, string | null>): void {
    const next = new URL(window.location.href);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) next.searchParams.delete(key);
      else next.searchParams.set(key, value);
    }
    window.history.replaceState(null, "", next);
  }
  function chooseProject(value: string): void {
    navigation.navigate(() => {
      const next = new URLSearchParams();
      if (value !== "global") next.set("project", value.slice(8));
      navigation.setDirty(false);
      logger.info("memory.context.selected", {
        projectName: next.get("project"),
      });
      window.history.pushState(
        null,
        "",
        `/memory${next.size > 0 ? `?${next}` : ""}`,
      );
      setLocation(next.toString());
    });
  }
  const initialNoteScope = {
    projectName,
    sessionName: params.get("session"),
    ...(params.has("incarnation")
      ? { incarnation: params.get("incarnation") ?? "" }
      : {}),
  };
  return (
    <div className="app" data-page="memory">
      <Topbar
        page="memory"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          ...(projectName === null
            ? []
            : [
                {
                  label: projectName,
                  href: `/projects/${encodeURIComponent(projectName)}`,
                  isProject: true,
                },
              ]),
          { label: "memory" },
        ]}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-lg overflow-hidden p-xl max-768:gap-sm max-768:p-md">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-md">
          <h1 className="m-0 font-display text-[1.5rem] font-extrabold tracking-[-0.03em] text-text-primary">
            Memory
          </h1>
          <Select
            value={projectName === null ? "global" : `project:${projectName}`}
            onValueChange={chooseProject}
          >
            <SelectTrigger aria-label="Memory context">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Global</SelectItem>
              {(projects.data ?? []).map((project) => (
                <SelectItem
                  key={project.name}
                  value={`project:${project.name}`}
                >
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {projects.isError ? (
          <p role="alert" className="font-mono text-[0.72rem] text-red-text">
            Could not load projects
          </p>
        ) : null}
        <MemoryLibraryPanel
          key={projectName ?? "global"}
          projectName={projectName}
          sessionName={null}
          conversationId={params.get("conversation")}
          previewSessionName={params.get("previewSession")}
          active
          layout="page"
          initialView={params.get("view") === "index" ? "index" : "library"}
          initialQueue={initialQueue}
          initialNoteId={params.get("note")}
          initialNoteScope={initialNoteScope}
          onDirtyChange={navigation.setDirty}
          onLocationChange={updateLocation}
        />
      </main>
      {navigation.dialog}
    </div>
  );
}
