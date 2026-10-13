/**
 * A template's structure as the editor shows it, read-only: each context's
 * dependencies, routes, lane and loop, and the diagram's nodes and edges.
 * Contexts, dependencies, routes, loops and lanes change only when an agent
 * saves a new definition.
 */
import type { ProjectBackendModelOptions } from "@/lib/agent-backends/project-model-options-schema";
import type { CascadedSettings } from "@/lib/config/settings-cascade";
import type {
  RunTemplateContent,
  RunTemplateContext,
} from "@/lib/run-templates/document";
import { guardLabel, schemaLabel } from "@/lib/runs/labels";
import type { ImplementerSetting, RunSettings } from "@/lib/runs/settings";
import type {
  RunEdge,
  RunLane,
  RunLoop,
  SeatSummary,
} from "@/components/runs/model";
import type { DiagramContext } from "./components/RunDiagram";
import { catalogFor, modelOf } from "./seat-model";
import { contextSettings } from "./template-model";

type Dependency = NonNullable<RunTemplateContext["dependsOn"]>[number];

export interface DependencyView {
  key: string;
  /** Needs the source's accepted output, not its code. */
  outputOnly: boolean;
  /** The route's guard as it reads, when the dependency is guarded. */
  guard: string | null;
}

export function dependenciesOf(context: RunTemplateContext): DependencyView[] {
  return (context.dependsOn ?? []).map((dependency: Dependency) =>
    typeof dependency === "string"
      ? { key: dependency, outputOnly: false, guard: null }
      : {
          key: dependency.key,
          outputOnly: dependency.outputOnly === true,
          guard:
            dependency.when === undefined ? null : guardLabel(dependency.when),
        },
  );
}

/** The loop a context runs in, with its exit condition as it reads. */
export function loopOf(
  draft: RunTemplateContent,
  key: string,
): { key: string; maxPasses: number; until: string } | null {
  const loop = draft.workflow.loops?.find((each) => each.body.includes(key));
  return loop === undefined
    ? null
    : {
        key: loop.key,
        maxPasses: loop.maxPasses,
        until: schemaLabel(loop.until.schema),
      };
}

/** What a context without a title is called: the first line of its brief, as a launch titles it. */
export function untitledName(context: RunTemplateContext): string {
  const firstLine = context.brief.split("\n")[0]?.trim() ?? "";
  return firstLine === "" ? context.key : firstLine;
}

export function contextTitle(context: RunTemplateContext): string {
  return context.title ?? untitledName(context);
}

function implementerSeat(
  implementer: ImplementerSetting,
  models: readonly ProjectBackendModelOptions[],
): SeatSummary | null {
  if (implementer.backend === undefined) return null;
  const selection = implementer.modelSelection;
  const catalog = catalogFor(models, implementer.backend);
  const model =
    selection === undefined
      ? "default model"
      : ((catalog === null ? null : modelOf(catalog, selection.modelId))
          ?.label ?? selection.modelId);
  return {
    assignment: "implementer",
    role: "implementer",
    backend: implementer.backend,
    model,
    effort: null,
  };
}

/** The diagram of a template: its contexts with their implementers, routes, lanes and loops. */
export function templateDiagram(
  globals: RunSettings,
  draft: RunTemplateContent,
  models: readonly ProjectBackendModelOptions[],
): {
  contexts: DiagramContext[];
  edges: RunEdge[];
  lanes: RunLane[];
  loops: RunLoop[];
} {
  const contexts = draft.workflow.contexts.map((context): DiagramContext => {
    const settings: CascadedSettings<RunSettings> = contextSettings(
      globals,
      draft,
      context.key,
    );
    const dependencies = dependenciesOf(context).map(({ key }) => key);
    const loop = loopOf(draft, context.key);
    return {
      key: context.key,
      title: contextTitle(context),
      placement:
        context.lane === undefined
          ? { kind: "session" }
          : { kind: "lane", lane: context.lane },
      loop:
        loop === null
          ? null
          : { key: loop.key, pass: 1, maxPasses: loop.maxPasses },
      dependsOn: dependencies,
      state: {
        kind: "waiting",
        dependencies,
        provisionLanes: [],
        publicationLanes: [],
      },
      tasks: { done: 0, total: context.tasks?.length ?? 0 },
      questions: [],
      costUsd: null,
      costComplete: true,
      implementer: implementerSeat(settings.implementer.value, models),
      reviewers: settings.reviewers.value.map((_, index) => ({
        assignment: `reviewer-${index + 1}`,
      })),
      humanApproval: settings.humanApproval.value,
      startedAt: null,
    };
  });
  const edges = draft.workflow.contexts.flatMap((context) =>
    dependenciesOf(context).map(
      (dependency): RunEdge => ({
        from: dependency.key,
        to: context.key,
        guard:
          dependency.guard === null
            ? null
            : { label: dependency.guard, state: "undecided" },
        outputOnly: dependency.outputOnly,
      }),
    ),
  );
  const lanes = (draft.workflow.lanes ?? []).map(
    (lane): RunLane => ({
      key: lane.key,
      branch: `lane ${lane.key}`,
      worktreePath: "",
      state: "waiting",
      attempt: null,
      detail: null,
      commit: null,
      checks: lane.checks ?? [],
    }),
  );
  const loops = (draft.workflow.loops ?? []).map(
    (loop): RunLoop => ({
      key: loop.key,
      body: loop.body,
      pass: 0,
      maxPasses: loop.maxPasses,
      state: "unstarted",
      until: schemaLabel(loop.until.schema),
    }),
  );
  return { contexts, edges, lanes, loops };
}
