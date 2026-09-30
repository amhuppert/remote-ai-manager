"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  FormGroup,
  FormLabel,
  FormInput,
  FormHint,
} from "@/components/ui/FormField";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogTrigger,
} from "@/components/ui/Dialog";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { SubscriptionSourceRef } from "@/lib/subscriptions/schemas";
import type { SubscriptionScope } from "@/lib/subscriptions/controls-schemas";
import {
  useSubscriptionCatalog,
  useSubscriptionRecipients,
} from "@/lib/subscriptions/queries";
import { useCreateSubscription } from "@/lib/subscriptions/mutations";
import { Choice, PageControls, ownerLabel } from "./SubscriptionPrimitives";

export function CreateSubscription({
  scope = {},
  target,
  source,
  onCreated,
}: {
  scope?: SubscriptionScope;
  target?: ConversationTarget;
  source?: SubscriptionSourceRef;
  onCreated?(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm" touch layoutClassName="shrink-0">
          + Subscribe
        </Button>
      </DialogTrigger>
      <DialogContent mobileSheet>
        <DialogTitle>New subscription</DialogTitle>
        <DialogDescription>
          Choose what this conversation should know, and when.
        </DialogDescription>
        {open ? (
          <SubscriptionForm
            scope={scope}
            target={target}
            source={source}
            onCreated={(id) => {
              setOpen(false);
              onCreated?.(id);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
function SubscriptionForm({
  scope,
  target,
  source,
  onCreated,
}: {
  scope: SubscriptionScope;
  target: ConversationTarget | undefined;
  source: SubscriptionSourceRef | undefined;
  onCreated(id: string): void;
}) {
  const prefix = useId();
  const catalog = useSubscriptionCatalog();
  const [recipientSearch, setRecipientSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [recipient, setRecipient] = useState<ConversationTarget | undefined>(
    target,
  );
  const recipients = useSubscriptionRecipients(
    {
      project: scope.project,
      session: scope.session,
      q: recipientSearch,
      limit: 10,
      offset,
    },
    !target,
  );
  const [kind, setKind] = useState<SubscriptionSourceRef["kind"]>(
    source?.kind ?? "notepad",
  );
  const [id, setId] = useState(source?.id ?? "");
  const [mode, setMode] = useState<"passive" | "active">("passive");
  const [reason, setReason] = useState("");
  const [lifetime, setLifetime] = useState("86400");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const mutation = useCreateSubscription();
  const entry = catalog.data?.sources.find((row) => row.kind === kind);
  return (
    <form
      className="mt-5 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!recipient) return;
        mutation.mutate(
          {
            target: recipient,
            subscription: {
              source: { kind, id: id.trim() },
              mode,
              reason: reason.trim(),
              eventKinds:
                mode === "passive" && selectedEvents.length
                  ? selectedEvents
                  : null,
              ...(mode === "active" ? { expiresIn: Number(lifetime) } : {}),
            },
          },
          { onSuccess: (result) => onCreated(result.subscription.id) },
        );
      }}
    >
      {!target ? (
        <div>
          <FormLabel htmlFor={`${prefix}-recipient`}>
            Recipient conversation
          </FormLabel>
          <FormInput
            id={`${prefix}-recipient`}
            placeholder="Search by conversation, project or session…"
            value={recipientSearch}
            onChange={(event) => {
              setRecipientSearch(event.target.value);
              setOffset(0);
            }}
          />
          {recipient ? (
            <p className="text-[0.72rem] text-cyan">
              Selected:{" "}
              {recipients.data?.items.find(
                (item) =>
                  item.target.conversationId === recipient.conversationId,
              )?.conversationTitle ?? recipient.conversationId}
            </p>
          ) : null}
          <div className="mt-2 flex max-h-[180px] flex-col gap-1 overflow-auto">
            {recipients.data?.items.map((owner) => (
              <Button
                key={owner.target.conversationId}
                variant={
                  recipient?.conversationId === owner.target.conversationId
                    ? "primary"
                    : "ghost"
                }
                size="sm"
                type="button"
                onClick={() => setRecipient(owner.target)}
              >
                {owner.conversationTitle} · {ownerLabel(owner)}
              </Button>
            ))}
          </div>
          {recipients.isError ? (
            <p role="alert" className="text-red">
              {recipients.error.message}
            </p>
          ) : null}
          {recipients.data && recipients.data.total > 10 ? (
            <PageControls
              total={recipients.data.total}
              limit={10}
              offset={offset}
              onPage={setOffset}
            />
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-[1fr_1.5fr] gap-3 max-480:grid-cols-1">
        <div>
          <FormLabel>Source type</FormLabel>
          <Choice
            label="Source type"
            value={kind}
            options={(catalog.data?.sources ?? []).map((item) => ({
              value: item.kind,
              label: item.label,
            }))}
            onChange={(value) => {
              const next = catalog.data?.sources.find(
                (row) => row.kind === value,
              );
              if (next) {
                setKind(next.kind);
                setMode("passive");
                setSelectedEvents([]);
                if (!source || next.kind !== source.kind) setId("");
              }
            }}
          />
        </div>
        <div>
          <FormLabel htmlFor={`${prefix}-id`}>
            {entry?.identityDescription ?? "Source ID"}
          </FormLabel>
          <FormInput
            id={`${prefix}-id`}
            required
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="Paste source ID"
          />
        </div>
      </div>
      <FormHint>{entry?.description}</FormHint>
      <div>
        <FormLabel>Delivery</FormLabel>
        <Choice
          label="Delivery mode"
          value={mode}
          options={[
            { value: "passive", label: "With the next user message" },
            ...(entry?.allowedModes.includes("active")
              ? [{ value: "active", label: "Wake once on completion" }]
              : []),
          ]}
          onChange={(value) =>
            setMode(value === "active" ? "active" : "passive")
          }
        />
      </div>
      {mode === "active" ? (
        <div>
          <FormLabel>Wait lifetime</FormLabel>
          <Choice
            label="Wait lifetime"
            value={lifetime}
            options={[
              { value: "3600", label: "1 hour" },
              { value: "86400", label: "24 hours" },
              { value: "604800", label: "7 days" },
            ]}
            onChange={setLifetime}
          />
          <FormHint>
            One wake for completion, failure, a missing source, or expiry. User
            questions and approval holds take priority.
          </FormHint>
        </div>
      ) : entry && entry.eventKinds.length > 1 ? (
        <details className="rounded-md border border-solid border-border-subtle p-3">
          <summary className="cursor-pointer font-mono text-[0.72rem] text-text-secondary">
            Events ·{" "}
            {selectedEvents.length
              ? `${selectedEvents.length} selected`
              : "All supported changes"}
          </summary>
          <div className="mt-3 flex max-h-[170px] flex-col gap-3 overflow-auto">
            {entry.eventKinds.map((event) => (
              <label
                key={event.id}
                className="flex items-center gap-3 text-[0.72rem] text-text-secondary"
              >
                <Checkbox
                  checked={selectedEvents.includes(event.id)}
                  onCheckedChange={(checked) =>
                    setSelectedEvents((previous) =>
                      checked
                        ? [...previous, event.id]
                        : previous.filter((id) => id !== event.id),
                    )
                  }
                />
                {event.label}
              </label>
            ))}
          </div>
        </details>
      ) : null}
      <FormGroup>
        <FormLabel htmlFor={`${prefix}-reason`}>Purpose</FormLabel>
        <FormInput
          id={`${prefix}-reason`}
          required
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. Continue the review when validation finishes"
        />
        <FormHint>The agent sees this reason alongside the event.</FormHint>
      </FormGroup>
      {mutation.isError ? (
        <p role="alert" className="m-0 text-[0.75rem] text-red">
          {mutation.error.message}
        </p>
      ) : null}
      {catalog.isError ? (
        <p role="alert" className="text-red">
          {catalog.error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <DialogClose asChild>
          <Button type="button" size="sm" touch>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          touch
          loading={mutation.isPending}
          disabled={!recipient || !entry || !id.trim() || !reason.trim()}
        >
          Subscribe
        </Button>
      </div>
    </form>
  );
}
