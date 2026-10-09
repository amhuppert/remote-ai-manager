"use client";

import { useState } from "react";
import { GearIcon, SearchIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { DiagramIcon, PlayIcon } from "../../icons";
import type { TemplateSummary } from "../../template-model";

export interface TemplateLibraryProps {
  templates: TemplateSummary[];
  onConfigure(template: TemplateSummary): void;
  onLaunch(template: TemplateSummary): void;
}

/** Discovery before configuration or launch; both actions retain the template's scope. */
export function TemplateLibrary({
  templates,
  onConfigure,
  onLaunch,
}: TemplateLibraryProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const search = query.trim().toLowerCase();
  const visible = templates.filter(
    (template) =>
      (scope === "all" || template.tier === scope) &&
      [template.name, template.description]
        .join(" ")
        .toLowerCase()
        .includes(search),
  );
  const projectCount = templates.filter(
    (template) => template.tier === "project",
  ).length;
  return (
    <section
      aria-label="Saved templates"
      className="mx-auto flex w-full max-w-[1080px] flex-col gap-xl px-2xl py-2xl max-768:px-lg max-768:py-xl"
    >
      <header className="flex flex-wrap items-end gap-lg">
        <div className="flex min-w-0 flex-1 flex-col gap-sm">
          <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-cyan uppercase">
            Workflows
          </span>
          <h1 className="m-0 font-display text-[1.75rem] font-extrabold tracking-[-0.01em] text-text-primary max-768:text-[1.4rem]">
            Saved templates
          </h1>
          <p className="m-0 max-w-[640px] font-mono text-[0.78rem] leading-[1.6] text-text-secondary">
            Choose a workflow, review its configuration, then launch it with an
            owner conversation.
          </p>
        </div>
        <div className="flex gap-xl max-640:hidden">
          <div className="flex flex-col gap-xs">
            <span className="font-mono text-[1.25rem] text-text-primary tabular-nums">
              {projectCount}
            </span>
            <span className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
              Project
            </span>
          </div>
          <div className="flex flex-col gap-xs">
            <span className="font-mono text-[1.25rem] text-text-primary tabular-nums">
              {templates.length - projectCount}
            </span>
            <span className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
              Global
            </span>
          </div>
        </div>
      </header>

      {templates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-md border-x-0 border-y border-solid border-border-dim py-lg">
          <div className="relative min-w-[180px] flex-1">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-md -translate-y-1/2 text-text-tertiary"
            >
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              aria-label="Search templates"
              placeholder="Search templates"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-[38px] w-full rounded-md border border-solid border-border-default bg-bg-base py-sm pr-md pl-2xl font-mono text-[0.78rem] text-text-primary placeholder:text-text-tertiary focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none"
            />
          </div>
          <SegmentedControl
            value={scope}
            onValueChange={setScope}
            aria-label="Template scope"
          >
            <SegmentedControlItem value="all">All</SegmentedControlItem>
            <SegmentedControlItem value="project">Project</SegmentedControlItem>
            <SegmentedControlItem value="global">Global</SegmentedControlItem>
          </SegmentedControl>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-solid border-border-subtle bg-bg-base">
          <EmptyState>
            <EmptyStateIcon>
              <DiagramIcon size={36} />
            </EmptyStateIcon>
            <EmptyStateTitle>
              {templates.length === 0
                ? "No saved templates"
                : "No matching templates"}
            </EmptyStateTitle>
            <EmptyStateDesc>
              {templates.length === 0
                ? "Ask a conversation to save a workflow as a template. It will appear here for configuration and launch."
                : "Try another name or scope to find a workflow."}
            </EmptyStateDesc>
            {templates.length > 0 ? (
              <Button
                variant="default"
                size="sm"
                touch
                layoutClassName="mt-lg"
                onClick={() => {
                  setQuery("");
                  setScope("all");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </EmptyState>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-md max-768:grid-cols-1">
          {visible.map((template) => {
            const tier = template.tier === "project" ? "Project" : "Global";
            return (
              <article
                key={`${template.tier}:${template.id}`}
                aria-label={`${template.name} · ${tier}`}
                className="flex min-w-0 flex-col gap-lg rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
              >
                <div className="flex items-start gap-md">
                  <span
                    aria-hidden="true"
                    className="flex size-[36px] shrink-0 items-center justify-center rounded-md border border-solid border-border-dim bg-bg-base text-text-secondary"
                  >
                    <DiagramIcon size={19} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-sm">
                    <h2 className="m-0 font-mono text-[0.88rem] leading-[1.5] font-semibold break-words text-text-primary">
                      {template.name}
                    </h2>
                    <div className="flex flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-secondary">
                      <Badge tier="count">{tier}</Badge>
                      <span>
                        {template.contexts}{" "}
                        {template.contexts === 1 ? "context" : "contexts"}
                      </span>
                    </div>
                  </div>
                </div>
                <p className="m-0 font-mono text-[0.78rem] leading-[1.6] text-text-secondary">
                  {template.description}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
                  <time
                    dateTime={template.updatedAt}
                    className="mr-auto font-mono text-[0.7rem] text-text-tertiary max-640:w-full"
                  >
                    Updated {formatLocalTime(template.updatedAt)}
                  </time>
                  <Button
                    variant="default"
                    size="sm"
                    touch
                    layoutClassName="max-640:flex-1"
                    onClick={() => onConfigure(template)}
                  >
                    <GearIcon size={13} />
                    Configure
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    touch
                    layoutClassName="max-640:flex-1"
                    onClick={() => onLaunch(template)}
                  >
                    <PlayIcon size={13} />
                    Launch
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
