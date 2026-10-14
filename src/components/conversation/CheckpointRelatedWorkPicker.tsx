"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FormGroup,
  FormInput,
  FormLabel,
  FormHint,
  FormError,
} from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { ticketQueries } from "@/lib/tickets/queries";
import { specReferenceQueries } from "@/lib/specs/reference-queries";
import {} from "@/lib/api/fetcher";
import type { CheckpointRelatedWork } from "@/lib/conversation-checkpoints/fork-schemas";

interface Option {
  id: string;
  label: string;
}
function WorkSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange(value: string): void;
  disabled: boolean;
}) {
  return (
    <FormGroup>
      <FormLabel>{label}</FormLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label} layoutClassName="w-full">
          <span className="min-w-0 truncate">
            <SelectValue placeholder={`Choose ${label.toLowerCase()}`} />
          </span>
        </SelectTrigger>
        <SelectContent contentLayer="popover">
          {options.slice(0, 100).map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {options.length === 0 && <FormHint>No matching choices.</FormHint>}
      {options.length > 100 && (
        <FormHint>
          Showing 100 choices. Narrow the search to find more.
        </FormHint>
      )}
    </FormGroup>
  );
}
export default function CheckpointRelatedWorkPicker({
  projectName,
  value,
  onChange,
  disabled,
}: {
  projectName: string;
  value: CheckpointRelatedWork | null;
  onChange(value: CheckpointRelatedWork | null): void;
  disabled: boolean;
}) {
  const [kind, setKind] = useState<CheckpointRelatedWork["kind"]>(
    value?.kind ?? "ticket",
  );
  const [search, setSearch] = useState("");
  const [specSlug, setSpecSlug] = useState("");
  const tickets = useQuery({
    ...ticketQueries.list({ projectName }),
    enabled: kind === "ticket",
  });
  const specs = useQuery({
    ...specReferenceQueries.inventory(projectName),
    enabled: kind === "spec_task",
  });
  const detail = useQuery({
    ...specReferenceQueries.pickerDetail(projectName, specSlug),
    enabled: kind === "spec_task" && specSlug !== "",
  });
  const matches = (label: string) =>
    label.toLowerCase().includes(search.toLowerCase());
  const ticketOptions = (tickets.data ?? []).map((ticket) => ({
    id: String(ticket.number),
    label: `${projectName}#${ticket.number} · ${ticket.title}`,
  }));
  if (
    value?.kind === "ticket" &&
    !ticketOptions.some((option) => option.id === String(value.ticketNumber))
  )
    ticketOptions.unshift({
      id: String(value.ticketNumber),
      label: `${projectName}#${value.ticketNumber}`,
    });
  const taskRows =
    detail.data?.currentRevision?.elements.filter(
      (row) => row.version.payload.kind === "task",
    ) ?? [];
  const relevantQuery = kind === "ticket" ? tickets : specSlug ? detail : specs;
  return (
    <div>
      <WorkSelect
        label="Related work"
        value={kind}
        disabled={disabled}
        options={[
          { id: "ticket", label: "Ticket" },
          { id: "spec_task", label: "Spec task" },
        ]}
        onChange={(next) => {
          setKind(next as CheckpointRelatedWork["kind"]);
          setSearch("");
          onChange(null);
        }}
      />
      <FormGroup>
        <FormInput
          aria-label="Search related work"
          placeholder="Search related work…"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </FormGroup>
      {kind === "ticket" && (
        <WorkSelect
          label="Ticket"
          value={value?.kind === "ticket" ? String(value.ticketNumber) : ""}
          disabled={disabled || tickets.isPending}
          options={ticketOptions.filter((option) => matches(option.label))}
          onChange={(id) => onChange({ kind, ticketNumber: Number(id) })}
        />
      )}
      {kind === "spec_task" && (
        <>
          <WorkSelect
            label="Spec"
            value={specSlug}
            disabled={disabled || specs.isPending}
            options={(specs.data?.specs ?? [])
              .map(({ spec }) => ({
                id: spec.slug,
                label: `${spec.slug} · ${spec.name}`,
              }))
              .filter((option) => matches(option.label))}
            onChange={(slug) => {
              setSpecSlug(slug);
              setSearch("");
              onChange(null);
            }}
          />
          {specSlug && (
            <WorkSelect
              label="Spec task"
              value={value?.kind === "spec_task" ? value.elementId : ""}
              disabled={disabled || detail.isPending}
              options={taskRows
                .map((row) => ({
                  id: row.element.id,
                  label: `T${row.element.number} · ${row.version.payload.kind === "task" ? row.version.payload.title : ""}`,
                }))
                .filter((option) => matches(option.label))}
              onChange={(elementId) => {
                if (detail.data?.currentRevision)
                  onChange({
                    kind,
                    specId: detail.data.spec.id,
                    revisionId: detail.data.currentRevision.revision.id,
                    elementId,
                  });
              }}
            />
          )}
        </>
      )}
      {relevantQuery.isPending && (
        <FormHint role="status">Loading related work…</FormHint>
      )}
      {relevantQuery.isError && (
        <FormError role="alert">
          Related work could not be loaded. Reopen the form to retry.
        </FormError>
      )}
    </div>
  );
}
