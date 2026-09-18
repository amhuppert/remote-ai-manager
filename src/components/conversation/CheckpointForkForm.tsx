"use client";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { CheckpointTarget } from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import { useEffect, useId, useRef, useState } from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import BackendToggle from "@/components/BackendToggle";
import { Button } from "@/components/ui/Button";
import {
  FormGroup,
  FormLabel,
  FormInput,
  FormHint,
  FormError,
} from "@/components/ui/FormField";
import { DesktopModelSelectionControls } from "@/components/session/prompt/ModelSelectionControls";
import {
  useBackendCatalogQuery,
  useProjectModelOptionsQuery,
} from "@/lib/agent-backends/queries";
import { checkpointForkBackendRefusal } from "@/lib/conversation-checkpoints/fork-backend-refusal";
import { validateModelSelection } from "@/lib/agent-backends/model-selection";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { CheckpointRelatedWork } from "@/lib/conversation-checkpoints/fork-schemas";
import { useCheckpointForkMutation } from "@/lib/conversation-checkpoints/fork-mutation";
import { createClientLogger } from "@/lib/logging/client-logger";
import CheckpointRelatedWorkPicker from "./CheckpointRelatedWorkPicker";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

export interface CheckpointForkFormProps {
  target: CheckpointTarget;
  receipt: CheckpointReceipt;
  source: PublicConversationState;
  initialModel?: BackendModelSelection;
  initialTicket?: number;
  active?: boolean;
  onPendingChange?(pending: boolean): void;
  onBack(): void;
  onCreated(conversation: PublicConversationState): void;
}
const logger = createClientLogger("checkpoint-fork-form");

export default function CheckpointForkForm({
  target,
  receipt,
  source,
  initialModel,
  initialTicket,
  active = true,
  onPendingChange,
  onBack,
  onCreated,
}: CheckpointForkFormProps): React.JSX.Element {
  const id = useId();
  const taskInput = useRef<HTMLTextAreaElement>(null);
  const taskAction = useRef<MultilineInputActionHandle>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (active) taskInput.current?.focus();
  }, [active]);
  const [name, setName] = useState(`${source.name} · Next phase`.slice(0, 200));
  const [task, setTask] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [relatedWork, setRelatedWork] = useState<CheckpointRelatedWork | null>(
    initialTicket ? { kind: "ticket", ticketNumber: initialTicket } : null,
  );
  const [backend, setBackend] = useState<AgentBackendId>(source.agentBackend);
  const [editedSelection, setEditedSelection] =
    useState<BackendModelSelection | null>(initialModel ?? null);
  const catalog = useBackendCatalogQuery();
  const options = useProjectModelOptionsQuery(target.projectName);
  const current = options.data?.find((entry) => entry.backend === backend);
  const selection = editedSelection ?? current?.defaultSelection ?? null;
  const backendEntry = catalog.data?.find((entry) => entry.id === backend);
  const validation =
    selection && current?.modelCatalog
      ? validateModelSelection(current.modelCatalog, selection)
      : null;
  const invalidReason = !backendEntry
    ? "Loading agent options…"
    : (checkpointForkBackendRefusal(backendEntry) ??
      (options.isError
        ? "Model options could not be loaded."
        : current?.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join(" ") || null) ??
      (!validation
        ? "Loading model options…"
        : validation.valid
          ? null
          : validation.issues.map((issue) => issue.message).join(" ")));
  const mutation = useCheckpointForkMutation(target, receipt.operationId);
  useEffect(() => {
    onPendingChange?.(mutation.isPending);
  }, [mutation.isPending, onPendingChange]);
  const requestIdentity = useRef<{ signature: string; id: string } | null>(
    null,
  );
  async function submit(nextTask: string) {
    setSubmitted(true);
    if (mutation.isPending || !selection || invalidReason || !name.trim())
      return;
    const body = {
      name: name.trim(),
      task: nextTask.trim(),
      relatedWork,
      backend,
      modelSelection: selection,
    };
    const signature = JSON.stringify(body);
    if (requestIdentity.current?.signature !== signature)
      requestIdentity.current = { signature, id: crypto.randomUUID() };
    try {
      const created = await mutation.mutateAsync({
        ...body,
        requestId: requestIdentity.current.id,
      });
      logger.info("checkpoint.fork.opened", {
        sourceConversationId: target.conversationId,
        operationId: receipt.operationId,
        conversationId: created.conversation.id,
        backend,
      });
      if (mounted.current) onCreated(created.conversation);
    } catch (error) {
      logger.warn("checkpoint.fork.creation_failed", {
        sourceConversationId: target.conversationId,
        operationId: receipt.operationId,
        backend,
        ...checkpointErrorFields(error),
      });
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        runMultilinePrimaryAction(
          [taskAction.current],
          () => void submit(task),
        );
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Fork from checkpoint"
    >
      <div className="overflow-y-auto px-xl py-lg max-768:px-lg">
        <div className="mb-lg rounded-md border border-solid border-border-subtle bg-bg-base p-lg font-mono text-[0.78rem] text-text-secondary">
          <p className="mb-xs font-medium text-text-primary">
            {source.name} · Checkpoint #{receipt.ordinal}
          </p>
          <p>
            Saved{" "}
            {new Date(
              receipt.checkpoint?.createdAt ?? receipt.requestedAt,
            ).toLocaleString()}{" "}
            · Through seq {receipt.boundary.capturedThroughSeq}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={mutation.isPending || voiceBusy}
            onClick={onBack}
          >
            View source evidence
          </Button>
        </div>
        <FormGroup>
          <FormLabel htmlFor={`${id}-name`}>Conversation name</FormLabel>
          <FormInput
            id={`${id}-name`}
            value={name}
            aria-required
            aria-invalid={submitted && !name.trim()}
            aria-describedby={
              submitted && !name.trim() ? `${id}-name-error` : undefined
            }
            maxLength={200}
            disabled={mutation.isPending}
            onChange={(event) => setName(event.target.value)}
          />
          {submitted && !name.trim() && (
            <FormError id={`${id}-name-error`} role="alert">
              Enter a conversation name.
            </FormError>
          )}
        </FormGroup>
        <FormGroup>
          <FormLabel htmlFor={`${id}-task`}>Next task</FormLabel>
          <FormHint>
            Optional. You can add a task after creating the fork.
          </FormHint>
          <MultilineInput
            ref={taskInput}
            id={`${id}-task`}
            value={task}
            maxLength={32768}
            rows={4}
            disabled={mutation.isPending}
            onValueChange={setTask}
            actionRef={taskAction}
            voiceProjectName={target.projectName}
            onPrimaryAction={(value) => void submit(value)}
            onVoiceStateChange={setVoiceBusy}
            placeholder="What should this conversation work on next?"
            className="w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-md py-sm font-mono text-[0.82rem] leading-relaxed text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-cyan"
          />
        </FormGroup>
        <FormHint>Related work is optional.</FormHint>
        <CheckpointRelatedWorkPicker
          projectName={target.projectName}
          value={relatedWork}
          onChange={setRelatedWork}
          disabled={mutation.isPending}
        />
        <FormGroup>
          <FormLabel>Initial agent · Editable before first message</FormLabel>
          <div className="flex flex-wrap items-center gap-md">
            <BackendToggle
              value={backend}
              onChange={(next) => {
                setBackend(next);
                setEditedSelection(null);
              }}
              disabled={mutation.isPending}
              disabledReason={checkpointForkBackendRefusal}
              touch
            />
            {current?.modelCatalog && selection && (
              <DesktopModelSelectionControls
                catalog={current.modelCatalog}
                selection={selection}
                onSelectionChange={setEditedSelection}
                disabled={mutation.isPending}
                invalidReason={invalidReason}
                selectContentLayer="popover"
              />
            )}
          </div>
          {invalidReason && <FormError>{invalidReason}</FormError>}
        </FormGroup>
        <FormHint>
          {target.scope === "session"
            ? "This conversation shares the session’s current worktree."
            : "This conversation uses the project’s current checkout."}{" "}
          The task opens as a draft. Send it to start the agent. You can change
          the backend and model in the conversation.
        </FormHint>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle px-xl py-lg max-768:px-lg">
        {mutation.error && (
          <div className="w-full">
            <FormError role="alert">{mutation.error.message}</FormError>
          </div>
        )}
        <Button
          type="button"
          onClick={onBack}
          disabled={mutation.isPending || voiceBusy}
        >
          Back
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={mutation.isPending}
          disabled={invalidReason !== null}
        >
          Create fork
        </Button>
      </div>
    </form>
  );
}
