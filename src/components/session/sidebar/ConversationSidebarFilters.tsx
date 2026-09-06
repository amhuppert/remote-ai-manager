"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import {
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";

interface Props {
  projects: string[];
  project: string | null;
  onProjectChange: (project: string | null) => void;
  includeArchived: boolean;
  onArchivedChange: (include: boolean) => void;
  includeGraphWorkflows: boolean;
  onGraphWorkflowsChange: (include: boolean) => void;
}

export default function ConversationSidebarFilters({
  projects,
  project,
  onProjectChange,
  includeArchived,
  onArchivedChange,
  includeGraphWorkflows,
  onGraphWorkflowsChange,
}: Props): React.JSX.Element {
  const sessionFilter = useSidebarSessionFilter();
  const setSessionFilter = useSetSidebarSessionFilter();
  return (
    <div className="@container flex flex-col gap-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-md gap-y-xs">
        <div className="min-w-0 basis-full @[480px]:basis-0 flex-1">
          <Select
            value={project === null ? "all" : `project:${project}`}
            onValueChange={(value) =>
              onProjectChange(value === "all" ? null : value.slice(8))
            }
          >
            <SelectTrigger
              layoutClassName="w-full"
              aria-label="Filter by project"
            >
              <span className="min-w-0 flex-1 truncate text-left">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((name) => (
                <SelectItem key={name} value={`project:${name}`}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex min-h-[36px] shrink-0 cursor-pointer items-center gap-sm font-mono text-[0.72rem] text-text-primary max-768:min-h-[44px]">
          <Switch
            size="sm"
            checked={includeGraphWorkflows}
            onCheckedChange={onGraphWorkflowsChange}
            aria-label="Show graph workflow conversations"
          />
          Workflows
        </label>
        <label className="flex min-h-[36px] shrink-0 cursor-pointer items-center gap-sm font-mono text-[0.72rem] text-text-primary max-768:min-h-[44px]">
          <Switch
            size="sm"
            checked={includeArchived}
            onCheckedChange={onArchivedChange}
            aria-label="Show archived conversations"
          />
          Archived
        </label>
      </div>
      {sessionFilter !== null && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSessionFilter(null)}
          aria-label={`Clear session filter (${sessionFilter.sessionName})`}
        >
          <span className="truncate">Session: {sessionFilter.sessionName}</span>
          <span aria-hidden="true">×</span>
        </Button>
      )}
    </div>
  );
}
