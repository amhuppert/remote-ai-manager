/**
 * Run template writes from the UI: saving a template from the editor and
 * launching one from the library or the editor. Neither outcome can be
 * predicted (the server validates and may refuse a stale revision), so each
 * control shows its own pending state (rung 3); the caches move once the
 * server answers, and the `run-template-changed` and `run-changed` events
 * refresh them again.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiCallError } from "@/lib/api/errors";
import { mutationFetch } from "@/lib/api/fetcher";
import { runKeys } from "@/lib/runs/query-keys";
import {
  runTemplateLaunchedResponseSchema,
  type RunTemplateLaunchRequest,
  type RunTemplateTier,
} from "@/lib/runs/schemas";
import {
  runTemplateSavedResponseSchema,
  type RunTemplateContent,
  type RunTemplateDetailResponse,
  type RunTemplateRecord,
} from "./document";
import { runTemplateKeys } from "./query-keys";

/** How a save ended; any other refusal throws, its located issues in its message. */
export type RunTemplateSaveResult =
  | { kind: "saved"; template: RunTemplateRecord }
  /** Someone saved another revision first; null when the server did not say which. */
  | { kind: "conflict"; currentRevision: number | null };

export interface RunTemplateSaveRequest {
  tier: RunTemplateTier;
  id: string;
  /** The revision the content was edited from; null creates the template. */
  expectedRevision: number | null;
  template: RunTemplateContent;
}

function json(method: "PUT" | "POST", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function currentRevisionOf(error: ApiCallError): number | null {
  const revision = error.details?.["currentRevision"];
  return typeof revision === "number" ? revision : null;
}

/** A refusal as one message: the server's, then each located issue on its own line. */
function refusalMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const issues =
    error instanceof ApiCallError
      ? (error.issues ?? []).map(({ path, message }) => `${path}: ${message}`)
      : [];
  return [error.message, ...issues].join("\n");
}

export function useSaveRunTemplateMutation(projectName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["run-templates", projectName, "save"],
    mutationFn: async ({
      tier,
      id,
      expectedRevision,
      template,
    }: RunTemplateSaveRequest): Promise<RunTemplateSaveResult> => {
      try {
        const saved = await mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/run-templates/${tier}/${encodeURIComponent(id)}`,
          "run-templates.save",
          json("PUT", { expectedRevision, template }),
          runTemplateSavedResponseSchema,
        );
        return { kind: "saved", template: saved.template };
      } catch (error) {
        if (
          error instanceof ApiCallError &&
          error.code === "run_template_revision_conflict"
        )
          return {
            kind: "conflict",
            currentRevision: currentRevisionOf(error),
          };
        throw new Error(refusalMessage(error, "Could not save the template."));
      }
    },
    onSuccess: (result, { tier, id }) => {
      if (result.kind !== "saved") return;
      queryClient.setQueryData<RunTemplateDetailResponse>(
        runTemplateKeys.detail(projectName, tier, id),
        // The write's event can refetch first and cache a newer revision another writer saved.
        (previous) =>
          previous === undefined ||
          previous.template.revision >= result.template.revision
            ? previous
            : { ...previous, template: result.template },
      );
      void queryClient.invalidateQueries({
        queryKey: runTemplateKeys.list(projectName),
      });
    },
  });
}

/** Why a launch was refused, at the parameter it names when it names one. */
export interface RunTemplateLaunchRefusal {
  message: string;
  parameter?: string;
}

const PARAMETER_PATH = /^parameters\.(.+)$/;

export function launchRefusalOf(error: unknown): RunTemplateLaunchRefusal {
  if (!(error instanceof ApiCallError))
    return {
      message: error instanceof Error ? error.message : "The launch failed.",
    };
  if (error.code === "run_template_changed") {
    const revision = currentRevisionOf(error);
    return {
      message: `The template was saved again since this dialog opened${revision === null ? "" : `; it is now at revision ${revision}`}. Review the latest revision, then launch it.`,
    };
  }
  for (const issue of error.issues ?? []) {
    const parameter = PARAMETER_PATH.exec(issue.path)?.[1];
    if (parameter !== undefined) return { message: issue.message, parameter };
  }
  return { message: refusalMessage(error, "The launch failed.") };
}

/** Launch a template as a person, naming the owner and the revision the dialog showed. */
export function useLaunchRunTemplateMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["run-templates", projectName, sessionName, "launch"],
    mutationFn: (request: RunTemplateLaunchRequest) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/runs/template`,
        "runs.template_launch",
        json("POST", request),
        runTemplateLaunchedResponseSchema,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: runKeys.list(projectName, sessionName),
      }),
  });
}
