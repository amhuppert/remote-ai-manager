"use client";

import { useId, useState } from "react";
import { PlayIcon } from "@/components/runs/icons";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/RadioGroup";
import type { RunTemplateLaunchRefusal } from "@/lib/run-templates/mutations";
import type { RunTemplateSummary } from "@/lib/run-templates/schemas";
import type { RunTemplateLaunchRequest } from "@/lib/runs/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";
import { BackendDiamond } from "../parts";
import { INPUT } from "./fields";

/** A conversation of the session that can own the run. */
export interface OwnerChoice {
  conversationId: string;
  title: string;
  backend: AgentBackendId;
  /** In a turn now: the run's first update waits for it to end. */
  busy: boolean;
}

/** What the dialog shows of the template, and the revision it launches. */
export type LaunchableTemplate = Pick<
  RunTemplateSummary,
  "tier" | "id" | "name" | "revision" | "parameters" | "contexts"
>;

const NEW = "__new";

/**
 * Launching a template from the UI: the run needs an owner conversation, which
 * receives its questions, halts and result, so the person picks one or starts
 * a new one; then the template's parameters. The request names the revision
 * the dialog showed, so a template changed since is refused, not launched.
 */
function LaunchDialogBody({
  open,
  template,
  sessionName,
  owners,
  submitting = false,
  refusal = null,
  initialValues = {},
  onOpenChange,
  onLaunch,
}: {
  open: boolean;
  template: LaunchableTemplate;
  sessionName: string;
  owners: readonly OwnerChoice[];
  submitting?: boolean;
  refusal?: RunTemplateLaunchRefusal | null;
  /** Values the person entered before, such as the ones a refused launch sent. */
  initialValues?: Record<string, string>;
  onOpenChange(open: boolean): void;
  onLaunch(request: RunTemplateLaunchRequest): void;
}) {
  const [owner, setOwner] = useState<string>(owners[0]?.conversationId ?? NEW);
  const [newTitle, setNewTitle] = useState(`${template.name} owner`);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [touched, setTouched] = useState(false);
  const [dismissedRefusal, setDismissedRefusal] =
    useState<RunTemplateLaunchRefusal | null>(null);
  const activeRefusal = refusal === dismissedRefusal ? null : refusal;
  const formId = useId();
  const missing = template.parameters.filter(
    (parameter) =>
      parameter.required && (values[parameter.name] ?? "").trim() === "",
  );
  const missingOwnerName = owner === NEW && newTitle.trim() === "";
  const contexts = `${template.contexts} ${template.contexts === 1 ? "context" : "contexts"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" mobileSheet>
        <DialogTitle>Launch {template.name}</DialogTitle>
        <DialogDescription>
          {contexts} · revision {template.revision} · session {sessionName}.
        </DialogDescription>
        <form
          id={formId}
          className="mt-lg flex flex-col gap-xl"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (submitting || missing.length > 0 || missingOwnerName) return;
            onLaunch({
              template: {
                tier: template.tier,
                id: template.id,
                revision: template.revision,
              },
              owner:
                owner === NEW
                  ? { kind: "new", title: newTitle.trim() }
                  : { kind: "existing", conversationId: owner },
              parameters: Object.fromEntries(
                template.parameters.map(({ name }) => [
                  name,
                  values[name] ?? "",
                ]),
              ),
            });
          }}
        >
          <fieldset
            disabled={submitting}
            className="m-0 flex flex-col gap-sm border-0 p-0"
          >
            <legend className="mb-sm p-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
              Owner
            </legend>
            <p className="m-0 mb-[2px] font-mono text-[0.72rem] leading-[1.5] text-text-tertiary">
              The owner receives the run&apos;s questions, halts and result, and
              can amend or repair it.
            </p>
            <RadioGroup
              value={owner}
              onValueChange={setOwner}
              aria-label="Owner conversation"
              layoutClassName="flex flex-col"
            >
              {[
                ...owners,
                {
                  conversationId: NEW,
                  title: "New conversation",
                  backend: null,
                  busy: false,
                },
              ].map((choice) => {
                const checked = owner === choice.conversationId;
                return (
                  <label
                    key={choice.conversationId}
                    data-checked={checked}
                    className="flex cursor-pointer items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-base px-md py-[10px] transition-colors duration-150 hover:border-border-strong data-[checked=true]:border-[var(--cc-cyan-a35)] data-[checked=true]:bg-bg-raised"
                  >
                    <RadioGroupItem
                      value={choice.conversationId}
                      aria-label={choice.title}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className="flex min-w-0 items-center gap-sm font-mono text-[0.78rem] font-medium text-text-primary">
                        {choice.backend === null ? null : (
                          <BackendDiamond backend={choice.backend} />
                        )}
                        <span className="truncate">{choice.title}</span>
                      </span>
                      <span className="font-mono text-[0.7rem] text-text-tertiary">
                        {choice.backend === null
                          ? "Created without a model turn; it wakes when the run first needs it."
                          : choice.busy
                            ? "Working now; the run's first update waits for its turn to end."
                            : "Idle in this session."}
                      </span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
            {owner === NEW ? (
              <label className="mt-[2px] flex flex-col gap-[6px] pl-[34px]">
                <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
                  Name
                </span>
                <input
                  className={INPUT}
                  value={newTitle}
                  maxLength={200}
                  aria-invalid={touched && missingOwnerName}
                  aria-describedby={
                    touched && missingOwnerName
                      ? `${formId}-owner-error`
                      : undefined
                  }
                  onChange={(event) => setNewTitle(event.target.value)}
                />
                {touched && missingOwnerName ? (
                  <span
                    id={`${formId}-owner-error`}
                    className="font-mono text-[0.72rem] text-red-text"
                  >
                    Enter a name for the owner conversation.
                  </span>
                ) : null}
              </label>
            ) : null}
          </fieldset>

          {template.parameters.length > 0 ? (
            <fieldset
              disabled={submitting}
              className="m-0 flex flex-col gap-md border-0 p-0"
            >
              <legend className="mb-sm p-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
                Parameters
              </legend>
              {template.parameters.map((parameter) => {
                const invalid =
                  (touched &&
                    missing.some((other) => other.name === parameter.name)) ||
                  activeRefusal?.parameter === parameter.name;
                const errorId = `${formId}-${parameter.name}-error`;
                const hintId = `${formId}-${parameter.name}-hint`;
                return (
                  <label
                    key={parameter.name}
                    className="flex flex-col gap-[6px]"
                  >
                    <span className="flex flex-wrap items-baseline gap-sm">
                      <code className="font-mono text-[0.78rem] font-semibold text-text-primary">
                        {parameter.name}
                      </code>
                      <span
                        id={hintId}
                        className="font-mono text-[0.72rem] text-text-tertiary"
                      >
                        {parameter.description}
                        {parameter.required ? "" : " · optional"}
                      </span>
                    </span>
                    <input
                      className={cn(INPUT, invalid && "border-red")}
                      value={values[parameter.name] ?? ""}
                      aria-label={parameter.name}
                      aria-invalid={invalid}
                      aria-describedby={
                        invalid ? `${hintId} ${errorId}` : hintId
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        if (
                          activeRefusal?.parameter === parameter.name &&
                          value !== (values[parameter.name] ?? "")
                        )
                          setDismissedRefusal(activeRefusal);
                        setValues((current) => ({
                          ...current,
                          [parameter.name]: value,
                        }));
                      }}
                    />
                    {invalid ? (
                      <span
                        id={errorId}
                        className="font-mono text-[0.72rem] text-red-text"
                      >
                        {activeRefusal?.parameter === parameter.name
                          ? activeRefusal.message
                          : "Required."}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </fieldset>
          ) : null}

          {activeRefusal !== null && activeRefusal.parameter === undefined ? (
            <p
              role="alert"
              className="m-0 rounded-md border border-solid border-[var(--cc-red-a40)] bg-red-glow px-md py-sm font-mono text-[0.72rem] leading-[1.5] text-red-text"
            >
              {activeRefusal.message}
            </p>
          ) : null}
        </form>
        <DialogActions layoutClassName="mt-lg">
          <Button
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={submitting}
          >
            <PlayIcon size={12} />
            {submitting ? "Launching…" : "Launch run"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** A different scope-qualified template starts with its own launch values and owner. */
export function LaunchDialog(props: Parameters<typeof LaunchDialogBody>[0]) {
  return (
    <LaunchDialogBody
      key={`${props.template.tier}:${props.template.id}`}
      {...props}
    />
  );
}
