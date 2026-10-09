"use client";

import { useId, useState } from "react";
import { PlayIcon } from "../../icons";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/RadioGroup";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";
import { BackendDiamond } from "../parts";
import type { Template } from "../../template-model";
import { INPUT } from "./fields";

export interface OwnerChoice {
  conversationId: string;
  title: string;
  backend: AgentBackendId;
  busy: boolean;
}

export interface LaunchRequest {
  owner: { kind: "existing"; conversationId: string } | { kind: "new"; title: string };
  parameters: Record<string, string>;
}

const NEW = "__new";

/**
 * Launching a template from the UI: the run needs an owner conversation, which
 * receives its questions, halts and result, so the person picks one or starts
 * a new one; then the template's parameters.
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
  template: Template;
  sessionName: string;
  owners: OwnerChoice[];
  submitting?: boolean;
  /** The launch's refusal, located at its field when it has one. */
  refusal?: { message: string; parameter?: string } | null;
  /** Values the person entered before, such as the ones a refused launch sent. */
  initialValues?: Record<string, string>;
  onOpenChange(open: boolean): void;
  onLaunch(request: LaunchRequest): void;
}) {
  const [owner, setOwner] = useState<string>(owners[0]?.conversationId ?? NEW);
  const [newTitle, setNewTitle] = useState(`${template.name} owner`);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [touched, setTouched] = useState(false);
  const [dismissedRefusal, setDismissedRefusal] = useState<typeof refusal>(null);
  const activeRefusal = refusal === dismissedRefusal ? null : refusal;
  const formId = useId();
  const missing = template.parameters.filter((parameter) => parameter.required && (values[parameter.name] ?? "").trim() === "");
  const lanes = template.lanes.length;
  const missingOwnerName = owner === NEW && newTitle.trim() === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" mobileSheet>
        <DialogTitle>Launch {template.name}</DialogTitle>
        <DialogDescription>
          {template.contexts.length} contexts{lanes > 0 ? ` · ${lanes} isolated lanes` : ""} · session {sessionName}.
        </DialogDescription>
        <form
          id={formId}
          className="mt-lg flex flex-col gap-xl"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (submitting || missing.length > 0 || missingOwnerName) return;
            onLaunch({
              owner: owner === NEW ? { kind: "new", title: newTitle.trim() } : { kind: "existing", conversationId: owner },
              parameters: values,
            });
          }}
        >
          <fieldset className="m-0 flex flex-col gap-sm border-0 p-0">
            <legend className="mb-sm p-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
              Owner
            </legend>
            <p className="m-0 mb-[2px] font-mono text-[0.72rem] leading-[1.5] text-text-tertiary">
              The owner receives the run&apos;s questions, halts and result, and can amend or repair it.
            </p>
            <RadioGroup value={owner} onValueChange={setOwner} aria-label="Owner conversation" layoutClassName="flex flex-col gap-[6px]">
              {[...owners, { conversationId: NEW, title: "New conversation", backend: "claude" as const, busy: false }].map((choice) => {
                const isNew = choice.conversationId === NEW;
                const checked = owner === choice.conversationId;
                return (
                  <label
                    key={choice.conversationId}
                    data-checked={checked}
                    className="flex cursor-pointer items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-base px-md py-[10px] transition-colors duration-150 hover:border-border-strong data-[checked=true]:border-[var(--cc-cyan-a35)] data-[checked=true]:bg-bg-raised"
                  >
                    <RadioGroupItem value={choice.conversationId} aria-label={choice.title} />
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className="flex items-center gap-sm font-mono text-[0.78rem] font-medium text-text-primary">
                        {isNew ? null : <BackendDiamond backend={choice.backend} />}
                        {choice.title}
                      </span>
                      <span className="font-mono text-[0.7rem] text-text-tertiary">
                        {isNew
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
                <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">Name</span>
                <input className={INPUT} value={newTitle} aria-invalid={touched && missingOwnerName} aria-describedby={touched && missingOwnerName ? `${formId}-owner-error` : undefined} onChange={(event) => setNewTitle(event.target.value)} />
                {touched && missingOwnerName ? <span id={`${formId}-owner-error`} className="font-mono text-[0.72rem] text-red-text">Enter a name for the owner conversation.</span> : null}
              </label>
            ) : null}
          </fieldset>

          {template.parameters.length > 0 ? (
            <fieldset className="m-0 flex flex-col gap-md border-0 p-0">
              <legend className="mb-sm p-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
                Parameters
              </legend>
              {template.parameters.map((parameter) => {
                const invalid =
                  (touched && missing.some((other) => other.name === parameter.name)) || activeRefusal?.parameter === parameter.name;
                const errorId = `${formId}-${parameter.name}-error`;
                const hintId = `${formId}-${parameter.name}-hint`;
                return (
                  <label key={parameter.name} className="flex flex-col gap-[6px]">
                    <span className="flex flex-wrap items-baseline gap-sm">
                      <code className="font-mono text-[0.78rem] font-semibold text-text-primary">{parameter.name}</code>
                      <span id={hintId} className="font-mono text-[0.72rem] text-text-tertiary">
                        {parameter.description}
                        {parameter.required ? "" : " · optional"}
                      </span>
                    </span>
                    <input
                      className={cn(INPUT, invalid && "border-red")}
                      value={values[parameter.name] ?? ""}
                      aria-label={parameter.name}
                      aria-invalid={invalid}
                      aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (activeRefusal?.parameter === parameter.name && value !== (values[parameter.name] ?? "")) setDismissedRefusal(activeRefusal);
                        setValues((current) => ({ ...current, [parameter.name]: value }));
                      }}
                    />
                    {invalid ? (
                      <span id={errorId} className="font-mono text-[0.72rem] text-red-text">
                        {activeRefusal?.parameter === parameter.name ? activeRefusal.message : "Required."}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </fieldset>
          ) : null}

          {activeRefusal !== null && activeRefusal.parameter === undefined ? (
            <p role="alert" className="m-0 rounded-md border border-solid border-[var(--cc-red-a40)] bg-red-glow px-md py-sm font-mono text-[0.72rem] leading-[1.5] text-red-text">
              {activeRefusal.message}
            </p>
          ) : null}
        </form>
        <DialogActions layoutClassName="mt-lg">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={submitting}>
            <PlayIcon size={12} />
            Launch run
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** A different scope-qualified template starts with its own launch values and owner. */
export function LaunchDialog(props: Parameters<typeof LaunchDialogBody>[0]) {
  return <LaunchDialogBody key={`${props.template.tier}:${props.template.id}`} {...props} />;
}
