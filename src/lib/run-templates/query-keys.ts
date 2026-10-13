import type { RunTemplateTier } from "@/lib/runs/schemas";

/**
 * Run template query keys, addressed by the project name the routes take. A
 * global template is read through any project, so each project caches its own
 * copy, under that project's prefix.
 */
export const runTemplateKeys = {
  all: ["run-templates"] as const,
  project: (projectName: string) =>
    [...runTemplateKeys.all, projectName] as const,
  list: (projectName: string) =>
    [...runTemplateKeys.project(projectName), "list"] as const,
  detail: (projectName: string, tier: RunTemplateTier, id: string) =>
    [...runTemplateKeys.project(projectName), "detail", tier, id] as const,
} as const;
