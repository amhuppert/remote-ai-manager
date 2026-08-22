"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useQueryClient } from "@tanstack/react-query";

import AgentProfilePicker from "@/components/agent-profiles/AgentProfilePicker";
import {
  parseAgentProfilePickerValue,
  STANDARD_AGENT_PROFILE_VALUE,
} from "@/components/agent-profiles/agent-profile-picker-state";
import BackendToggle from "@/components/BackendToggle";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import ModelSelector from "@/components/ModelSelector";
import { useProjectBackendModelOptions } from "@/lib/agent-backends/queries";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { ChatIcon, ChevronRightIcon, CloseIcon } from "@/components/icons";
import {
  MultilinePrimaryActionScope,
  useMultilinePrimaryActionRegistry,
} from "@/components/MultilineInput";
import {
  RichPromptInput,
  type RichPromptInputHandle,
} from "@/components/rich-prompt/RichPromptInput";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { IconButton } from "@/components/ui/IconButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { Switch } from "@/components/ui/Switch";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { resolveConfiguredBackendSelectionDefaults } from "@/lib/agent-backends/catalog";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import { readCapturedClientErrors } from "@/lib/client-errors/ring-buffer";
import { useFullConfigQuery } from "@/lib/config/queries";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  useCommandCenterProjectQuery,
  useProjectsQuery,
} from "@/lib/projects/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import {
  pastedImageUploadFile,
  planDescriptionImageSync,
  type DescriptionImageUpload,
} from "@/lib/tickets/description-images";
import {
  useAddTicketAttachmentMutation,
  useCreateTicketMutation,
  useStartTicketMutation,
} from "@/lib/tickets/mutations";
import { ticketQueries } from "@/lib/tickets/queries";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import {
  quickTicketBundleKeySchema,
  type QuickTicketBundleKey,
  type QuickTicketClientError,
  type QuickTicketDiagnostics,
  type TicketDetail,
} from "@/lib/tickets/schemas";
import {
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "@/lib/tickets/ticket-visuals";
import { pushToast, replaceActionToast } from "@/stores/toast.store";
import {
  isQuickTicketDraftDirty,
  useQuickTicketStore,
} from "@/stores/quick-ticket.store";
import AttachmentDialog, {
  type QueuedTicketAttachment,
} from "@/features/tickets/components/AttachmentDialog";
import {
  resolveKickoffSelection,
  type ResolvedKickoffSelection,
} from "./kickoff-selection";
import {
  captureQuickTicketScreenshot,
  type QuickTicketScreenshot,
} from "./screenshot";
import { reconcileQuickTicketStart } from "./start-reconciliation";

const logger = createClientLogger("quick-ticket");

const MODE_UNAVAILABLE_REASON =
  "The Command Center project isn't resolvable on this instance";

const BUNDLE_LABELS: Record<QuickTicketBundleKey, string> = {
  route: "Route and view state",
  identities: "Active identities",
  conversation: "Conversation",
  cctl: "cctl diagnostics",
  build: "Build information",
  screenshot: "Screenshot",
  clientErrors: "Client errors",
};

type ScreenshotState =
  | { status: "idle" | "capturing" | "failed" }
  | { status: "ready"; screenshot: QuickTicketScreenshot };

const QUEUED_KIND_LABELS: Record<QueuedTicketAttachment["kind"], string> = {
  file: "file",
  conversation: "conversation",
  session: "session",
  related_ticket: "related ticket",
  note: "note",
};

function currentLocation() {
  return {
    pathname: window.location.pathname,
    searchParams: new URLSearchParams(window.location.search),
  };
}

function viewState(): string {
  const shell = document.querySelector<HTMLElement>(".app");
  if (shell === null) return "{}";
  const state = { ...shell.dataset };
  delete state.ariaHidden;
  return JSON.stringify(state).slice(0, 2000);
}

type QuickTicketContextSnapshot = NonNullable<
  ReturnType<typeof useQuickTicketStore.getState>["contextSnapshot"]
>;

type DiagnosticFacts = Pick<
  QuickTicketDiagnostics,
  "capturedAt" | "route" | "identities" | "clientErrors"
>;

function diagnosticIdentities(
  context: QuickTicketContextSnapshot,
): QuickTicketDiagnostics["identities"] {
  const workflowExecutionId = document.querySelector<HTMLElement>(
    "[data-workflow-execution-id]",
  )?.dataset.workflowExecutionId;
  const deepLinks: QuickTicketDiagnostics["identities"]["deepLinks"] = [];
  if (context.projectName !== undefined) {
    deepLinks.push({
      label: "Project",
      href: `/projects/${encodeURIComponent(context.projectName)}`,
    });
  }
  if (context.projectName !== undefined && context.sessionName) {
    deepLinks.push({
      label: "Session",
      href: `/projects/${encodeURIComponent(context.projectName)}/${encodeURIComponent(context.sessionName)}`,
    });
  }
  if (context.conversation !== undefined) {
    deepLinks.push({
      label: "Conversation",
      href: conversationsPageHref({
        conversationId: context.conversation.conversationId,
      }),
    });
  }
  if (
    workflowExecutionId &&
    context.projectName !== undefined &&
    context.sessionName
  ) {
    deepLinks.push({
      label: "Workflow execution",
      href: `${sessionHref(context.projectName, context.sessionName)}/workflow`,
    });
  }
  return {
    ...(context.projectName === undefined
      ? {}
      : { projectName: context.projectName }),
    ...(context.sessionName ? { sessionName: context.sessionName } : {}),
    ...(context.conversation === undefined
      ? {}
      : { conversationId: context.conversation.conversationId }),
    ...(workflowExecutionId ? { workflowExecutionId } : {}),
    deepLinks,
  };
}

function captureDiagnosticFacts(
  context: QuickTicketContextSnapshot,
  clientErrors: QuickTicketClientError[],
): DiagnosticFacts {
  return {
    capturedAt: new Date().toISOString(),
    route: { url: window.location.href, viewState: viewState() },
    identities: diagnosticIdentities(context),
    clientErrors,
  };
}

function sessionHref(projectName: string, sessionName: string): string {
  return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
}

export interface QuickTicketDialogProps {
  captureScreenshot?: () => Promise<QuickTicketScreenshot>;
  readClientErrors?: () => QuickTicketClientError[];
}

export default function QuickTicketDialog({
  captureScreenshot = captureQuickTicketScreenshot,
  readClientErrors = readCapturedClientErrors,
}: QuickTicketDialogProps): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const open = useQuickTicketStore((state) => state.open);
  const lifecycleRevision = useQuickTicketStore(
    (state) => state.lifecycleRevision,
  );
  const bugMode = useQuickTicketStore((state) => state.bugMode);
  const draft = useQuickTicketStore((state) => state.draft);
  const draftRestored = useQuickTicketStore((state) => state.draftRestored);
  const contextSnapshot = useQuickTicketStore((state) => state.contextSnapshot);
  const projectsQuery = useProjectsQuery();
  const commandCenterQuery = useCommandCenterProjectQuery(open);
  const configQuery = useFullConfigQuery({ enabled: open });
  const createMutation = useCreateTicketMutation();
  const startMutation = useStartTicketMutation();
  const addAttachmentMutation = useAddTicketAttachmentMutation();
  const descriptionRef = useRef<RichPromptInputHandle | null>(null);
  const { captureOpener, restoreOpener } = useOpenerFocus();
  const primaryActions = useMultilinePrimaryActionRegistry();
  const projectId = useId();
  const titleId = useId();
  const modeHelpId = useId();
  const projectErrorId = useId();
  const projectStatusId = useId();
  const projectRetryId = useId();
  const titleErrorId = useId();
  const generation = useRef(0);
  const captureInFlight = useRef(false);
  const captureRequested = useRef(false);
  const observedLifecycleRevision = useRef(lifecycleRevision);
  const [screenshot, setScreenshot] = useState<ScreenshotState>({
    status: "idle",
  });
  const [diagnosticFacts, setDiagnosticFacts] =
    useState<DiagnosticFacts | null>(null);
  const [expanded, setExpanded] = useState<QuickTicketBundleKey[]>([]);
  const [projectIssue, setProjectIssue] = useState(false);
  const [projectRetryState, setProjectRetryState] = useState<
    "failed" | "empty" | null
  >(null);
  const [titleIssue, setTitleIssue] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedAttachments, setQueuedAttachments] = useState<
    QueuedTicketAttachment[]
  >([]);
  const [addContextOpen, setAddContextOpen] = useState(false);

  const projectOptions = useMemo(() => {
    const names = new Set(
      (projectsQuery.data ?? []).map((project) => project.name),
    );
    if (draft?.projectName) names.add(draft.projectName);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [draft?.projectName, projectsQuery.data]);
  const commandCenterProject = commandCenterQuery.data?.projectName ?? null;
  const modeUnavailable =
    !commandCenterQuery.isPending && commandCenterProject === null;
  const projectDiscoveryFailed =
    projectsQuery.isError || projectRetryState === "failed";
  const projectDiscoveryEmpty =
    (projectsQuery.isSuccess && projectsQuery.data.length === 0) ||
    projectRetryState === "empty";
  const projectDiscoveryUnavailable =
    projectDiscoveryFailed || projectDiscoveryEmpty;
  const projectDiscoveryRetrying = projectRetryState !== null;
  const projectSelectionBlocked =
    projectsQuery.isPending || projectDiscoveryUnavailable;
  const pending = createMutation.isPending;

  // Auto-start kickoff selection: null until the configuration is available;
  // starting without it omits the overrides so the server applies its own
  // configured defaults.
  const kickoffConfig = configQuery.data?.config;
  const kickoffDefaults =
    kickoffConfig === undefined
      ? null
      : resolveConfiguredBackendSelectionDefaults(kickoffConfig);
  const kickoffSelection =
    draft === null || kickoffConfig === undefined || kickoffDefaults === null
      ? null
      : resolveKickoffSelection({
          draft,
          defaultBackend: kickoffConfig.defaultAgentBackend,
          backendDefaults: kickoffDefaults,
        });

  // The kickoff turn runs inside the project the draft names, so its model
  // choices are that project's effective ones (spec D10). Null before a project
  // is chosen, which reads as "unknown" and leaves the catalog in place.
  const kickoffProjectModelOptions = useProjectBackendModelOptions(
    draft !== null && draft.projectName.length > 0 ? draft.projectName : null,
    kickoffSelection?.backend ?? DEFAULT_AGENT_BACKEND_ID,
  );

  const patchKickoff = (selection: ResolvedKickoffSelection) => {
    useQuickTicketStore.getState().updateQuickTicketDraft({
      kickoffBackend: selection.backend,
      kickoffModel: selection.model,
      kickoffReasoningEffort: selection.reasoningEffort ?? null,
    });
  };

  const changeKickoffBackend = (backend: AgentBackendId) => {
    if (kickoffDefaults === null) return;
    patchKickoff(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: backend,
          kickoffModel: null,
          kickoffReasoningEffort: null,
        },
        defaultBackend: backend,
        backendDefaults: kickoffDefaults,
      }),
    );
  };

  const changeKickoffModel = (model: string) => {
    if (kickoffSelection === null || kickoffDefaults === null) return;
    patchKickoff(
      resolveKickoffSelection({
        draft: {
          kickoffBackend: kickoffSelection.backend,
          kickoffModel: model,
          kickoffReasoningEffort: kickoffSelection.reasoningEffort ?? null,
        },
        defaultBackend: kickoffSelection.backend,
        backendDefaults: kickoffDefaults,
      }),
    );
  };

  const changeKickoffEffort = (effort: EffortLevel) => {
    if (kickoffSelection === null) return;
    patchKickoff({ ...kickoffSelection, reasoningEffort: effort });
  };

  const invalidateCapture = useCallback(() => {
    generation.current += 1;
    captureRequested.current = false;
  }, []);

  useEffect(() => {
    if (!open || !bugMode || draft === null || commandCenterQuery.isPending) {
      return;
    }

    const store = useQuickTicketStore.getState();
    if (commandCenterProject === null) {
      invalidateCapture();
      setScreenshot({ status: "idle" });
      setDiagnosticFacts(null);
      store.updateQuickTicketDraft({
        projectName: draft.preBugProjectName ?? "",
        workType: draft.preBugWorkType ?? "feature",
        preBugProjectName: null,
        preBugWorkType: null,
      });
      store.setQuickTicketBugMode(false);
      logger.warn("quick_ticket.bug_target_unavailable", {
        draftRestored,
      });
      return;
    }

    if (
      draft.projectName === commandCenterProject &&
      draft.workType === "bug"
    ) {
      return;
    }
    store.updateQuickTicketDraft({
      projectName: commandCenterProject,
      workType: "bug",
    });
    logger.info("quick_ticket.bug_target_reconciled", {
      projectName: commandCenterProject,
      draftRestored,
    });
  }, [
    bugMode,
    commandCenterProject,
    commandCenterQuery.isPending,
    draft,
    draftRestored,
    invalidateCapture,
    open,
  ]);

  const startScreenshotCapture = useCallback((): void => {
    if (captureInFlight.current) {
      captureRequested.current = true;
      return;
    }
    captureRequested.current = false;
    const captureGeneration = ++generation.current;
    const captureLifecycleRevision =
      useQuickTicketStore.getState().lifecycleRevision;
    captureInFlight.current = true;
    setScreenshot({ status: "capturing" });
    logger.info("quick_ticket.screenshot_started");
    void captureScreenshot()
      .then((captured) => {
        const state = useQuickTicketStore.getState();
        if (
          generation.current !== captureGeneration ||
          state.lifecycleRevision !== captureLifecycleRevision ||
          !state.open ||
          !state.bugMode
        ) {
          return;
        }
        setScreenshot({ status: "ready", screenshot: captured });
        logger.info("quick_ticket.screenshot_ready", {
          mediaType: captured.mediaType,
          width: captured.width,
          height: captured.height,
        });
      })
      .catch((error: unknown) => {
        const state = useQuickTicketStore.getState();
        if (
          generation.current !== captureGeneration ||
          state.lifecycleRevision !== captureLifecycleRevision ||
          !state.open ||
          !state.bugMode
        ) {
          return;
        }
        setScreenshot({ status: "failed" });
        logger.warn("quick_ticket.screenshot_failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      })
      .finally(() => {
        captureInFlight.current = false;
        const state = useQuickTicketStore.getState();
        if (captureRequested.current && state.open && state.bugMode) {
          startScreenshotCapture();
        }
      });
  }, [captureScreenshot]);

  useEffect(() => {
    if (observedLifecycleRevision.current === lifecycleRevision) return;
    observedLifecycleRevision.current = lifecycleRevision;
    invalidateCapture();
    setScreenshot({ status: "idle" });
    setDiagnosticFacts(null);
    setExpanded([]);
    setProjectIssue(false);
    setProjectRetryState(null);
    setTitleIssue(false);
    setSubmitError(null);
  }, [invalidateCapture, lifecycleRevision]);

  useEffect(() => {
    if (!open || !bugMode || contextSnapshot === null) return;
    setDiagnosticFacts(
      captureDiagnosticFacts(contextSnapshot, readClientErrors()),
    );
  }, [bugMode, contextSnapshot, lifecycleRevision, open, readClientErrors]);

  useEffect(() => {
    if (!open || !bugMode || screenshot.status !== "idle") return;
    startScreenshotCapture();
  }, [bugMode, open, screenshot.status, startScreenshotCapture]);

  const close = useCallback(() => {
    invalidateCapture();
    setScreenshot({ status: "idle" });
    const state = useQuickTicketStore.getState();
    const stashDraft = isQuickTicketDraftDirty(state);
    // Queued context (which can hold Files) lives in component state, so it
    // survives a stash/restore cycle but resets with a discarded draft.
    if (!stashDraft) setQueuedAttachments([]);
    state.closeQuickTicket({ stashDraft });
  }, [invalidateCapture]);

  const setBugReportMode = (enabled: boolean) => {
    if (draft === null) return;
    const store = useQuickTicketStore.getState();
    if (enabled) {
      if (commandCenterProject === null) return;
      store.updateQuickTicketDraft({
        preBugProjectName: draft.projectName,
        preBugWorkType: draft.workType,
        projectName: commandCenterProject,
        workType: "bug",
      });
      store.setQuickTicketBugMode(true);
      return;
    }
    invalidateCapture();
    store.updateQuickTicketDraft({
      projectName: draft.preBugProjectName ?? "",
      workType: draft.preBugWorkType ?? "feature",
      preBugProjectName: null,
      preBugWorkType: null,
    });
    store.setQuickTicketBugMode(false);
    setScreenshot({ status: "idle" });
    setDiagnosticFacts(null);
  };

  const retryProjectDiscovery = async () => {
    setProjectIssue(false);
    setProjectRetryState(projectDiscoveryFailed ? "failed" : "empty");
    logger.info("quick_ticket.project_discovery_retry_started");
    const result = await projectsQuery.refetch();
    const projectCount = result.data?.length ?? 0;
    setProjectRetryState(null);
    if (result.isError) {
      logger.warn("quick_ticket.project_discovery_retry_failed", {
        message:
          result.error instanceof Error
            ? result.error.message
            : "unknown error",
      });
    } else {
      logger.info("quick_ticket.project_discovery_retry_completed", {
        projectCount,
      });
    }
    if (!useQuickTicketStore.getState().open) return;
    window.requestAnimationFrame(() =>
      document
        .getElementById(
          result.isSuccess && projectCount > 0 ? projectId : projectRetryId,
        )
        ?.focus(),
    );
  };

  const diagnostics = (): QuickTicketDiagnostics | undefined => {
    if (!bugMode || contextSnapshot === null || draft === null)
      return undefined;
    const facts =
      diagnosticFacts ??
      captureDiagnosticFacts(contextSnapshot, readClientErrors());
    return {
      ...facts,
      ...(screenshot.status === "ready"
        ? { screenshot: screenshot.screenshot }
        : {}),
      removed: [...draft.removedBundleKeys],
    };
  };

  const showTicketCreated = (
    projectName: string,
    number: number,
    message = `${formatTicketIdentifier(projectName, number)} created`,
    toastId?: string,
  ) => {
    const action = {
      label: "View ticket",
      onClick: () => router.push(ticketDetailHref(projectName, number)),
    };
    if (toastId !== undefined) {
      replaceActionToast(toastId, message, action);
      return toastId;
    }
    return pushToast(message, { action });
  };

  const startCreatedTicket = async (
    ticket: Pick<TicketDetail, "id" | "projectName" | "number">,
    toastId: string,
    kickoff: ResolvedKickoffSelection | null,
    profile: AgentProfileRef | undefined,
  ) => {
    const identifier = formatTicketIdentifier(
      ticket.projectName,
      ticket.number,
    );
    const result = await reconcileQuickTicketStart({
      ticketId: ticket.id,
      start: () =>
        startMutation.mutateAsync({
          projectName: ticket.projectName,
          number: ticket.number,
          mode: "agent",
          ...(profile === undefined ? {} : { profile }),
          ...(kickoff === null
            ? {}
            : {
                backend: kickoff.backend,
                model: kickoff.model,
                ...(kickoff.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: kickoff.reasoningEffort }),
              }),
        }),
      refetchLinks: () =>
        queryClient.fetchQuery({
          ...ticketQueries.sessionLinks(ticket.projectName),
          staleTime: 0,
        }),
    });
    if (result.kind === "started") {
      const output = result.output;
      if (output.initialPromptQueued) {
        replaceActionToast(toastId, `Agent queued on ${identifier}`, {
          label: "Open conversation",
          onClick: () =>
            router.push(
              conversationsPageHref({
                conversationId: output.conversationId,
              }),
            ),
        });
        return;
      }
      replaceActionToast(
        toastId,
        "Session prepared — open it to send the kickoff prompt",
        {
          label: "Open session",
          onClick: () =>
            router.push(sessionHref(ticket.projectName, output.sessionName)),
        },
      );
      return;
    }
    if (result.kind === "active") {
      replaceActionToast(toastId, `Agent already active on ${identifier}`, {
        label: "Open session",
        onClick: () =>
          router.push(sessionHref(ticket.projectName, result.sessionName)),
      });
      return;
    }
    logger.error("quick_ticket.auto_start_failed", {
      projectName: ticket.projectName,
      ticketNumber: ticket.number,
      message:
        result.error instanceof Error ? result.error.message : "unknown error",
    });
    showTicketCreated(
      ticket.projectName,
      ticket.number,
      `Couldn't start agent on ${identifier} — ticket is intact`,
      toastId,
    );
  };

  const attachPastedImages = async (
    ticket: Pick<TicketDetail, "projectName" | "number">,
    uploads: readonly DescriptionImageUpload[],
  ) => {
    let failed = 0;
    for (const upload of uploads) {
      try {
        await addAttachmentMutation.mutateAsync({
          projectName: ticket.projectName,
          number: ticket.number,
          description: upload.description,
          file: pastedImageUploadFile(upload),
          fileName: upload.fileName,
          mediaType: upload.mediaType,
        });
      } catch (error) {
        failed += 1;
        logger.warn("quick_ticket.pasted_image_attach_failed", {
          projectName: ticket.projectName,
          ticketNumber: ticket.number,
          fileName: upload.fileName,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
    if (failed > 0) {
      showTicketCreated(
        ticket.projectName,
        ticket.number,
        `${failed} of ${uploads.length} pasted ${uploads.length === 1 ? "image" : "images"} couldn't be attached to ${formatTicketIdentifier(ticket.projectName, ticket.number)}`,
      );
    }
  };

  const attachQueuedContext = async (
    ticket: Pick<TicketDetail, "projectName" | "number">,
    queued: readonly QueuedTicketAttachment[],
  ) => {
    let failed = 0;
    for (const attachment of queued) {
      try {
        await addAttachmentMutation.mutateAsync({
          projectName: ticket.projectName,
          number: ticket.number,
          ...attachment.request,
        });
      } catch (error) {
        failed += 1;
        logger.warn("quick_ticket.queued_context_attach_failed", {
          projectName: ticket.projectName,
          ticketNumber: ticket.number,
          kind: attachment.kind,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
    if (failed > 0) {
      showTicketCreated(
        ticket.projectName,
        ticket.number,
        `${failed} of ${queued.length} queued context ${queued.length === 1 ? "attachment" : "attachments"} couldn't be added to ${formatTicketIdentifier(ticket.projectName, ticket.number)}`,
      );
    }
  };

  const submit = async () => {
    if (draft === null || pending) return;
    const invalidProject = draft.projectName.length === 0;
    const invalidTitle = draft.title.trim().length === 0;
    const projectNeedsDiscovery =
      invalidProject &&
      (projectsQuery.isPending || projectDiscoveryUnavailable);
    setProjectIssue(invalidProject && !projectNeedsDiscovery);
    setTitleIssue(invalidTitle);
    setSubmitError(null);
    if (projectNeedsDiscovery) {
      if (!projectsQuery.isPending) {
        window.requestAnimationFrame(() =>
          document.getElementById(projectRetryId)?.focus(),
        );
      }
      return;
    }
    if (invalidProject || invalidTitle) {
      const target = invalidProject ? projectId : titleId;
      window.requestAnimationFrame(() =>
        document.getElementById(target)?.focus(),
      );
      return;
    }

    const conversation = contextSnapshot?.conversation;
    const conversationContext =
      draft.conversationAttached && conversation !== undefined
        ? {
            sourceProjectName: conversation.projectName,
            sessionName: conversation.sessionName,
            conversationId: conversation.conversationId,
            title: conversation.title,
          }
        : undefined;
    const promptDoc = descriptionRef.current?.serialize() ?? {
      prompt: draft.description,
      images: [],
    };
    const imagePlan = planDescriptionImageSync({
      editorImages: promptDoc.images.map((image) => ({
        id: image.attachmentId,
        mediaType: image.mediaType,
        base64Data: image.base64Data,
        ...(image.inlineMarkerIndex !== undefined
          ? { inlineMarkerIndex: image.inlineMarkerIndex }
          : {}),
      })),
      existing: [],
    });
    try {
      logger.info("quick_ticket.create_started", {
        projectName: draft.projectName,
        bugMode,
        autoStart: draft.autoStart,
      });
      const result = await createMutation.mutateAsync({
        projectName: draft.projectName,
        input: {
          title: draft.title.trim(),
          description: promptDoc.prompt,
          workType: draft.workType,
          ...(conversationContext === undefined ? {} : { conversationContext }),
          ...(bugMode ? { diagnostics: diagnostics() } : {}),
          ...(draft.autoStart ? { autoStartRequested: true } : {}),
        },
      });
      invalidateCapture();
      useQuickTicketStore.getState().clearQuickTicket();
      setScreenshot({ status: "idle" });
      setDiagnosticFacts(null);
      setExpanded([]);
      logger.info("quick_ticket.created", {
        projectName: result.ticket.projectName,
        ticketNumber: result.ticket.number,
        warningCount: result.warnings.length,
      });
      const createdToastId = showTicketCreated(
        result.ticket.projectName,
        result.ticket.number,
        draft.autoStart
          ? `${formatTicketIdentifier(result.ticket.projectName, result.ticket.number)} created — starting agent…`
          : undefined,
      );
      for (const warning of result.warnings) {
        showTicketCreated(
          result.ticket.projectName,
          result.ticket.number,
          warning.message,
        );
      }
      if (imagePlan.uploads.length > 0) {
        void attachPastedImages(result.ticket, imagePlan.uploads);
      }
      if (queuedAttachments.length > 0) {
        const queued = queuedAttachments;
        setQueuedAttachments([]);
        void attachQueuedContext(result.ticket, queued);
      }
      if (draft.autoStart) {
        void startCreatedTicket(
          result.ticket,
          createdToastId,
          kickoffSelection,
          // Always explicit, including the untouched default: the wire says
          // which profile this session runs under rather than leaving it to be
          // inferred (R7.1).
          parseAgentProfilePickerValue(
            draft.kickoffProfile ?? STANDARD_AGENT_PROFILE_VALUE,
          ) ?? undefined,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't create the ticket";
      setSubmitError(message);
      logger.error("quick_ticket.create_failed", {
        projectName: draft.projectName,
        message,
      });
    }
  };

  const requestSubmit = () => {
    const description = descriptionRef.current;
    if (description?.isVoiceBusy() === true) {
      // Finalizing dictation routes back through onSubmit once the
      // transcription lands, so the dictated text is part of the ticket.
      description.primaryAction();
      return;
    }
    primaryActions.primaryAction(() => void submit());
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    requestSubmit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    requestSubmit();
  };

  const discardRestoredDraft = () => {
    invalidateCapture();
    // The rich editor seeds from the draft only at mount, so clear it
    // explicitly alongside the store reset.
    descriptionRef.current?.clear();
    setQueuedAttachments([]);
    useQuickTicketStore.getState().discardQuickTicketDraft(currentLocation());
    setScreenshot({ status: "idle" });
    setDiagnosticFacts(null);
    setExpanded([]);
    setProjectIssue(false);
    setTitleIssue(false);
    setSubmitError(null);
    window.requestAnimationFrame(() =>
      document.getElementById(titleId)?.focus(),
    );
  };

  const removeBundleKey = (key: QuickTicketBundleKey) => {
    if (draft === null) return;
    const visibleKeys = quickTicketBundleKeySchema.options.filter(
      (candidate) => !draft.removedBundleKeys.includes(candidate),
    );
    const index = visibleKeys.indexOf(key);
    const successor = visibleKeys[index + 1] ?? visibleKeys[index - 1];
    useQuickTicketStore.getState().removeQuickTicketBundleKey(key);
    window.requestAnimationFrame(() => {
      const successorElement =
        successor === undefined
          ? null
          : document.getElementById(`quick-ticket-bundle-row-${successor}`);
      (
        successorElement ?? document.getElementById("quick-ticket-bundle")
      )?.focus();
    });
  };

  const restoreBundleKeys = () => {
    useQuickTicketStore.getState().restoreQuickTicketBundleKeys();
    window.requestAnimationFrame(() =>
      document.getElementById("quick-ticket-bundle")?.focus(),
    );
  };

  const bundleValue = (key: QuickTicketBundleKey): string => {
    if (key === "route") {
      return diagnosticFacts?.route.url ?? window.location.href;
    }
    if (key === "identities") {
      return (
        [
          diagnosticFacts?.identities.projectName,
          diagnosticFacts?.identities.sessionName,
          diagnosticFacts?.identities.conversationId,
          diagnosticFacts?.identities.workflowExecutionId,
        ]
          .filter(Boolean)
          .join(" · ") || "No active identity"
      );
    }
    if (key === "conversation") {
      return contextSnapshot?.conversation?.title ?? "No active conversation";
    }
    if (key === "cctl") return "Collected by the server after submit";
    if (key === "build") return "Resolved by the server after submit";
    if (key === "clientErrors") {
      const clientErrors = diagnosticFacts?.clientErrors ?? [];
      return `${clientErrors.length} sanitized ${clientErrors.length === 1 ? "error" : "errors"}`;
    }
    if (screenshot.status === "capturing") return "Capturing page…";
    if (screenshot.status === "failed") return "Capture failed";
    if (screenshot.status === "ready") {
      return `${screenshot.screenshot.width} × ${screenshot.screenshot.height}`;
    }
    return "Not captured";
  };

  const toggleExpanded = (key: QuickTicketBundleKey) => {
    setExpanded((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : [...current, key],
    );
  };

  if (draft === null || contextSnapshot === null) {
    return <Dialog open={false} />;
  }

  const visibleBundleKeys = quickTicketBundleKeySchema.options.filter(
    (key) => !draft.removedBundleKeys.includes(key),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        mobileSheet="full-height"
        onOpenAutoFocus={(event) => {
          captureOpener();
          event.preventDefault();
          window.requestAnimationFrame(() =>
            document.getElementById(titleId)?.focus(),
          );
        }}
        onCloseAutoFocus={restoreOpener}
      >
        <MultilinePrimaryActionScope registry={primaryActions}>
          <form
            className="flex max-h-[calc(100dvh-72px)] min-h-0 flex-col max-768:h-full"
            onSubmit={handleSubmit}
            onKeyDown={handleKeyDown}
          >
            <div className="flex shrink-0 items-center justify-between gap-md">
              <DialogTitle>New ticket</DialogTitle>
              {draftRestored ? (
                <div className="flex items-center gap-sm">
                  <StatusChip tone="amber">Draft restored</StatusChip>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Discard restored draft"
                    onClick={discardRestoredDraft}
                    disabled={pending}
                  >
                    Discard
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-xs">
              <div className="mb-lg flex items-start justify-between gap-lg rounded-md border border-solid border-border-subtle bg-bg-base p-md">
                <div className="min-w-0">
                  <label
                    htmlFor="quick-ticket-bug-mode"
                    className="block cursor-pointer font-mono text-[0.78rem] font-semibold text-text-primary"
                  >
                    Command Center bug report
                  </label>
                  <p
                    id={modeHelpId}
                    className="mt-xs font-mono text-[0.7rem] text-text-tertiary"
                  >
                    {modeUnavailable
                      ? "unavailable on this instance"
                      : bugMode
                        ? "files to command-center · type bug · bundle below"
                        : "retarget to command-center and attach a diagnostic bundle"}
                  </p>
                </div>
                <WithTooltip
                  label={modeUnavailable ? MODE_UNAVAILABLE_REASON : null}
                >
                  <span
                    className="inline-flex shrink-0"
                    tabIndex={modeUnavailable ? 0 : undefined}
                    aria-label={
                      modeUnavailable
                        ? `Command Center bug report unavailable: ${MODE_UNAVAILABLE_REASON}`
                        : undefined
                    }
                  >
                    <Switch
                      id="quick-ticket-bug-mode"
                      aria-label="Command Center bug report mode"
                      aria-describedby={modeHelpId}
                      checked={bugMode}
                      disabled={
                        pending ||
                        commandCenterQuery.isPending ||
                        modeUnavailable
                      }
                      onCheckedChange={setBugReportMode}
                    />
                  </span>
                </WithTooltip>
              </div>

              {!bugMode ? (
                <section aria-labelledby="quick-ticket-target-heading">
                  <h3
                    id="quick-ticket-target-heading"
                    className="mb-sm font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
                  >
                    Target
                  </h3>
                  <div className="grid grid-cols-2 gap-md max-768:grid-cols-1">
                    <FormGroup>
                      <FormLabel htmlFor={projectId}>Project</FormLabel>
                      <Select
                        value={draft.projectName}
                        disabled={pending || projectSelectionBlocked}
                        onValueChange={(projectName) => {
                          useQuickTicketStore
                            .getState()
                            .updateQuickTicketDraft({ projectName });
                          setProjectIssue(false);
                        }}
                      >
                        <SelectTrigger
                          id={projectId}
                          layoutClassName="w-full"
                          aria-required="true"
                          aria-invalid={projectIssue || undefined}
                          aria-describedby={
                            (projectsQuery.isPending &&
                              !projectDiscoveryRetrying) ||
                            projectDiscoveryUnavailable
                              ? projectStatusId
                              : projectIssue
                                ? projectErrorId
                                : undefined
                          }
                        >
                          <SelectValue
                            placeholder={
                              projectsQuery.isPending &&
                              !projectDiscoveryRetrying
                                ? "Loading projects…"
                                : projectDiscoveryFailed
                                  ? "Projects unavailable"
                                  : projectDiscoveryEmpty
                                    ? "No projects discovered"
                                    : "Choose project…"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {projectOptions.map((projectName) => (
                            <SelectItem key={projectName} value={projectName}>
                              {projectName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {projectsQuery.isPending && !projectDiscoveryRetrying ? (
                        <FormHint id={projectStatusId} role="status">
                          Loading projects…
                        </FormHint>
                      ) : projectDiscoveryUnavailable ? (
                        <div
                          id={projectStatusId}
                          role={projectDiscoveryFailed ? "alert" : "status"}
                          className="mt-xs flex items-center justify-between gap-sm"
                        >
                          <p
                            className={
                              projectDiscoveryFailed
                                ? "font-mono text-[0.72rem] text-red"
                                : "font-mono text-[0.7rem] text-text-tertiary"
                            }
                          >
                            {projectDiscoveryFailed
                              ? "Couldn't load projects."
                              : "No projects were discovered."}
                          </p>
                          <Button
                            id={projectRetryId}
                            type="button"
                            variant="ghost"
                            size="sm"
                            loading={projectDiscoveryRetrying}
                            disabled={pending}
                            layoutClassName="shrink-0"
                            onClick={() => void retryProjectDiscovery()}
                          >
                            {projectDiscoveryRetrying ? "Retrying…" : "Retry"}
                          </Button>
                        </div>
                      ) : projectIssue ? (
                        <FormError id={projectErrorId}>
                          Choose an owning project.
                        </FormError>
                      ) : null}
                    </FormGroup>
                    <FormGroup>
                      <FormLabel htmlFor="quick-ticket-work-type">
                        Work type
                      </FormLabel>
                      <Select
                        value={draft.workType}
                        disabled={pending}
                        onValueChange={(workType) =>
                          useQuickTicketStore
                            .getState()
                            .updateQuickTicketDraft({
                              workType: workType as typeof draft.workType,
                            })
                        }
                      >
                        <SelectTrigger
                          id="quick-ticket-work-type"
                          layoutClassName="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TICKET_WORK_TYPE_ORDER.map((workType) => (
                            <SelectItem key={workType} value={workType}>
                              {TICKET_WORK_TYPE_LABELS[workType]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormGroup>
                  </div>
                </section>
              ) : null}

              <FormGroup>
                <FormLabel htmlFor={titleId}>Title</FormLabel>
                <FormInput
                  id={titleId}
                  value={draft.title}
                  disabled={pending}
                  aria-required="true"
                  aria-invalid={titleIssue || undefined}
                  aria-describedby={titleIssue ? titleErrorId : undefined}
                  placeholder="What needs doing?"
                  onChange={(event) => {
                    useQuickTicketStore
                      .getState()
                      .updateQuickTicketDraft({ title: event.target.value });
                    setTitleIssue(false);
                  }}
                />
                {titleIssue ? (
                  <FormError id={titleErrorId}>Title is required.</FormError>
                ) : null}
              </FormGroup>

              <FormGroup>
                <FormLabel htmlFor="quick-ticket-description">
                  Description
                </FormLabel>
                <RichPromptInput
                  id="quick-ticket-description"
                  ref={descriptionRef}
                  capabilityContext={{ projectName: draft.projectName }}
                  value={draft.description}
                  onValueChange={(description) =>
                    useQuickTicketStore.getState().updateQuickTicketDraft({
                      description,
                    })
                  }
                  onSubmit={() => void submit()}
                  ariaLabel="Description"
                  placeholder="Add useful context (optional) — paste images to attach them"
                  submitLabel="Create ticket"
                  showSubmitControl={false}
                  disabled={pending}
                  allowEmptySubmit
                  onError={pushToast}
                />
              </FormGroup>

              {!bugMode &&
              draft.conversationAttached &&
              contextSnapshot.conversation !== undefined ? (
                <section
                  className="mb-lg"
                  aria-labelledby="quick-ticket-context"
                >
                  <h3
                    id="quick-ticket-context"
                    className="mb-sm font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
                  >
                    Context
                  </h3>
                  <div className="flex items-center gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-sm">
                    <ChatIcon size={16} className="shrink-0 text-cyan" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[0.76rem] text-text-primary">
                        {contextSnapshot.conversation.title}
                      </p>
                      <p className="truncate font-mono text-[0.68rem] text-text-tertiary">
                        conversation · compaction snapshot generates after
                        create
                      </p>
                    </div>
                    <IconButton
                      type="button"
                      variant="ghost"
                      aria-label="Remove conversation context"
                      disabled={pending}
                      onClick={() => {
                        useQuickTicketStore
                          .getState()
                          .removeQuickTicketBundleKey("conversation");
                        window.requestAnimationFrame(() =>
                          document
                            .getElementById("quick-ticket-auto-start")
                            ?.focus(),
                        );
                      }}
                    >
                      <CloseIcon size={14} />
                    </IconButton>
                  </div>
                </section>
              ) : null}

              <section
                className="mb-lg"
                aria-labelledby="quick-ticket-extra-context"
              >
                <div className="mb-sm flex items-center justify-between gap-md">
                  <h3
                    id="quick-ticket-extra-context"
                    className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
                  >
                    Additional context
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setAddContextOpen(true)}
                  >
                    Add context
                  </Button>
                </div>
                {queuedAttachments.length === 0 ? (
                  <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
                    Files, conversations, sessions, related tickets, or notes —
                    attached right after the ticket is created.
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-xs p-0">
                    {queuedAttachments.map((attachment) => (
                      <li
                        key={attachment.localId}
                        className="flex items-center gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-sm"
                      >
                        <StatusChip tone="cyan">
                          {QUEUED_KIND_LABELS[attachment.kind]}
                        </StatusChip>
                        <div className="min-w-0 flex-1">
                          <p className="m-0 truncate font-mono text-[0.76rem] text-text-primary">
                            {attachment.request.description}
                          </p>
                          <p className="m-0 truncate font-mono text-[0.68rem] text-text-tertiary">
                            {attachment.summary}
                          </p>
                        </div>
                        <IconButton
                          type="button"
                          variant="ghost"
                          aria-label="Remove queued context"
                          disabled={pending}
                          onClick={() =>
                            setQueuedAttachments((current) =>
                              current.filter(
                                (candidate) =>
                                  candidate.localId !== attachment.localId,
                              ),
                            )
                          }
                        >
                          <CloseIcon size={14} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {bugMode ? (
                <section
                  className="mb-lg"
                  aria-labelledby="quick-ticket-bundle"
                >
                  <div className="mb-sm flex items-center justify-between gap-md">
                    <h3
                      id="quick-ticket-bundle"
                      tabIndex={-1}
                      className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
                    >
                      Diagnostic bundle
                    </h3>
                    <div className="flex items-center gap-sm">
                      <StatusChip tone="cyan">
                        {visibleBundleKeys.length} of 7
                      </StatusChip>
                      {draft.removedBundleKeys.length > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label="Restore removed bundle items"
                          disabled={pending}
                          onClick={restoreBundleKeys}
                        >
                          Restore removed
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p
                    className="sr-only"
                    role="status"
                    aria-label="Diagnostic bundle status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {`Diagnostic bundle: ${visibleBundleKeys.length} of 7 items. Screenshot: ${draft.removedBundleKeys.includes("screenshot") ? "excluded" : bundleValue("screenshot")}.`}
                  </p>
                  <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-solid border-border-default bg-bg-base">
                    {visibleBundleKeys.map((key) => {
                      const isExpanded = expanded.includes(key);
                      return (
                        <div key={key}>
                          <div className="flex items-center gap-sm p-sm">
                            {key === "screenshot" &&
                            screenshot.status === "ready" ? (
                              <Image
                                className="h-[34px] w-[52px] shrink-0 rounded-sm border border-solid border-border-subtle object-cover"
                                src={`data:${screenshot.screenshot.mediaType};base64,${screenshot.screenshot.base64}`}
                                alt="Captured page thumbnail"
                                width={52}
                                height={34}
                                unoptimized
                              />
                            ) : (
                              <span className="inline-flex size-[18px] shrink-0 items-center justify-center font-mono text-[0.68rem] text-cyan">
                                {key === "clientErrors" ? "!" : "·"}
                              </span>
                            )}
                            <button
                              id={`quick-ticket-bundle-row-${key}`}
                              type="button"
                              className="flex min-w-0 flex-1 appearance-none items-center gap-sm border-0 bg-transparent p-0 text-left text-inherit focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                              aria-expanded={isExpanded}
                              onClick={() => toggleExpanded(key)}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-[0.74rem] font-medium text-text-primary">
                                  {BUNDLE_LABELS[key]}
                                </span>
                                <span className="block truncate font-mono text-[0.68rem] text-text-tertiary">
                                  {bundleValue(key)}
                                </span>
                              </span>
                              <ChevronRightIcon
                                size={14}
                                className={
                                  isExpanded
                                    ? "shrink-0 rotate-90 text-text-tertiary"
                                    : "shrink-0 text-text-tertiary"
                                }
                              />
                            </button>
                            <IconButton
                              type="button"
                              variant="ghost"
                              aria-label={`Remove ${BUNDLE_LABELS[key]} from bundle`}
                              disabled={pending}
                              onClick={() => removeBundleKey(key)}
                            >
                              <CloseIcon size={14} />
                            </IconButton>
                          </div>
                          {isExpanded ? (
                            <div className="border-t border-solid border-border-subtle bg-bg-surface px-md py-sm font-mono text-[0.68rem] break-words text-text-secondary">
                              {key === "route" && diagnosticFacts !== null ? (
                                <dl className="space-y-xs">
                                  <div>
                                    <dt className="text-text-tertiary">URL</dt>
                                    <dd>{diagnosticFacts.route.url}</dd>
                                  </div>
                                  <div>
                                    <dt className="text-text-tertiary">
                                      View state
                                    </dt>
                                    <dd>{diagnosticFacts.route.viewState}</dd>
                                  </div>
                                  <div>
                                    <dt className="text-text-tertiary">
                                      Captured at
                                    </dt>
                                    <dd>{diagnosticFacts.capturedAt}</dd>
                                  </div>
                                </dl>
                              ) : key === "identities" &&
                                diagnosticFacts !== null ? (
                                <dl className="space-y-xs">
                                  {[
                                    [
                                      "Project",
                                      diagnosticFacts.identities.projectName,
                                    ],
                                    [
                                      "Session",
                                      diagnosticFacts.identities.sessionName,
                                    ],
                                    [
                                      "Conversation",
                                      diagnosticFacts.identities.conversationId,
                                    ],
                                    [
                                      "Workflow execution",
                                      diagnosticFacts.identities
                                        .workflowExecutionId,
                                    ],
                                  ].map(([label, value]) =>
                                    value ? (
                                      <div key={label}>
                                        <dt className="text-text-tertiary">
                                          {label}
                                        </dt>
                                        <dd>{value}</dd>
                                      </div>
                                    ) : null,
                                  )}
                                  {diagnosticFacts.identities.deepLinks.map(
                                    (link) => (
                                      <div key={`${link.label}-${link.href}`}>
                                        <dt className="text-text-tertiary">
                                          {link.label} link
                                        </dt>
                                        <dd>{link.href}</dd>
                                      </div>
                                    ),
                                  )}
                                </dl>
                              ) : key === "screenshot" &&
                                screenshot.status === "ready" ? (
                                <Image
                                  className="max-h-[220px] w-full rounded-sm object-contain"
                                  src={`data:${screenshot.screenshot.mediaType};base64,${screenshot.screenshot.base64}`}
                                  alt="Captured page preview"
                                  width={screenshot.screenshot.width}
                                  height={screenshot.screenshot.height}
                                  unoptimized
                                />
                              ) : key === "clientErrors" &&
                                diagnosticFacts !== null &&
                                diagnosticFacts.clientErrors.length > 0 ? (
                                <ul className="space-y-xs">
                                  {diagnosticFacts.clientErrors.map((entry) => (
                                    <li
                                      key={`${entry.ts}-${entry.kind}-${entry.message}`}
                                      className="space-y-xs"
                                    >
                                      <div>{entry.ts}</div>
                                      <div>
                                        {entry.kind}: {entry.message}
                                      </div>
                                      {entry.stackHead.map((frame) => (
                                        <div key={frame}>{frame}</div>
                                      ))}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                bundleValue(key)
                              )}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    <p className="p-sm font-mono text-[0.66rem] text-text-tertiary">
                      Everything above attaches to the ticket — remove anything
                      you don&apos;t want captured.
                    </p>
                  </div>
                </section>
              ) : null}

              <div className="mb-lg">
                <CheckboxField
                  id="quick-ticket-auto-start"
                  label="Start agent after create"
                  description={
                    draft.autoStart && kickoffSelection !== null
                      ? "Creates a session and sends the ticket kickoff prompt with the agent configured below."
                      : "Creates a session and sends the ticket kickoff prompt using the project's configured backend, model, and effort defaults."
                  }
                  checked={draft.autoStart}
                  disabled={pending}
                  onCheckedChange={(checked) =>
                    useQuickTicketStore.getState().updateQuickTicketDraft({
                      autoStart: checked === true,
                    })
                  }
                />
                {draft.autoStart ? (
                  <div className="mt-md flex flex-col gap-2xs">
                    <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Agent profile
                    </span>
                    <AgentProfilePicker
                      projectName={draft.projectName}
                      value={
                        draft.kickoffProfile ?? STANDARD_AGENT_PROFILE_VALUE
                      }
                      onChange={(selection) =>
                        useQuickTicketStore.getState().updateQuickTicketDraft({
                          kickoffProfile: selection.value,
                        })
                      }
                      disabled={pending}
                    />
                  </div>
                ) : null}
                {draft.autoStart && kickoffSelection !== null ? (
                  <div className="mt-md flex flex-wrap items-end gap-lg">
                    <div className="flex flex-col gap-2xs">
                      <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                        Backend
                      </span>
                      <BackendToggle
                        value={kickoffSelection.backend}
                        onChange={changeKickoffBackend}
                        disabled={pending}
                      />
                    </div>
                    <div className="flex flex-col gap-2xs">
                      <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                        Model
                      </span>
                      <ModelSelector
                        backend={kickoffSelection.backend}
                        value={kickoffSelection.model}
                        onChange={changeKickoffModel}
                        disabled={pending}
                        projectOptions={kickoffProjectModelOptions}
                      />
                    </div>
                    <div className="flex flex-col gap-2xs">
                      <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                        Reasoning
                      </span>
                      <ReasoningLevelSelector
                        value={kickoffSelection.reasoningEffort ?? "high"}
                        onChange={changeKickoffEffort}
                        availableLevels={kickoffSelection.effortLevels}
                        disabled={pending}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {submitError !== null ? (
                <div
                  role="alert"
                  className="mb-lg flex items-center justify-between gap-md rounded-md border border-solid border-red-dim bg-red-glow p-sm"
                >
                  <p className="font-mono text-[0.72rem] text-red">
                    {submitError}
                  </p>
                  <Button type="button" size="sm" onClick={requestSubmit}>
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="shrink-0 border-t border-solid border-border-subtle pt-md">
              <div className="flex items-center justify-between gap-md max-768:items-end">
                <FormHint layoutClassName="m-0">
                  {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter
                </FormHint>
                <DialogActions layoutClassName="m-0">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={close}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={pending}
                    disabled={
                      draft.projectName.length === 0 && projectSelectionBlocked
                    }
                  >
                    {bugMode ? "File bug report" : "Create ticket"}
                  </Button>
                </DialogActions>
              </div>
            </div>
          </form>
        </MultilinePrimaryActionScope>
      </DialogContent>
      {/* Outside the primary-action scope so its inputs never route the
          outer form's Cmd+Enter; queued items attach after create. */}
      <AttachmentDialog
        projectName={draft.projectName}
        open={addContextOpen}
        onOpenChange={setAddContextOpen}
        onQueue={(attachment) =>
          setQueuedAttachments((current) => [...current, attachment])
        }
      />
    </Dialog>
  );
}
