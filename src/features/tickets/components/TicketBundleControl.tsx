"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogActions,
  DialogTrigger,
} from "@/components/ui/Dialog";
import {
  FormError,
  FormGroup,
  FormLabel,
  FormInput,
} from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { useProjectsQuery } from "@/lib/projects/queries";
import {
  useBundleTransfer,
  usePrepareBundle,
  useProceedBundle,
} from "@/lib/tickets/bundle-client";
import type { BundleTransfer } from "@/lib/tickets/bundle-transfer-schemas";

export function TicketBundleReview({
  transfer,
  busy,
  onProceed,
}: {
  transfer: BundleTransfer;
  busy: boolean;
  onProceed(allowDuplicate: boolean): void;
}): React.JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const duplicate = transfer.status === "duplicate";
  const ready = transfer.status === "ready" || duplicate;
  return (
    <div className="flex flex-col gap-md font-mono">
      <p className="m-0 text-sm text-text-primary">
        {transfer.title} · {transfer.documentCount} documents
      </p>
      {transfer.omissions.length > 0 && (
        <>
          <div className="max-h-[240px] overflow-auto rounded-md border border-solid border-amber-dim p-md">
            <p className="m-0 text-sm text-amber">
              Missing context ({transfer.omissions.length})
            </p>
            <ul className="m-0 pl-lg text-sm text-text-secondary">
              {transfer.omissions.map((item, index) => (
                <li
                  key={`${item.source}-${index}`}
                  className="mt-sm break-words"
                >
                  {item.source}: {item.reason}
                </li>
              ))}
            </ul>
          </div>
          <CheckboxField
            label="I acknowledge the missing context listed above"
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
            disabled={busy}
          />
        </>
      )}
      {duplicate && (
        <>
          <FormError>{transfer.error}</FormError>
          <CheckboxField
            label="Create another copy of this ticket"
            checked={allowDuplicate}
            onCheckedChange={(value) => setAllowDuplicate(value === true)}
            disabled={busy}
          />
        </>
      )}
      {ready && (
        <Button
          variant="primary"
          disabled={
            busy ||
            (transfer.omissions.length > 0 && !acknowledged) ||
            (duplicate && !allowDuplicate)
          }
          onClick={() => onProceed(allowDuplicate)}
        >
          {busy
            ? "Working…"
            : transfer.mode === "export"
              ? "Download bundle"
              : "Import ticket"}
        </Button>
      )}
    </div>
  );
}

export default function TicketBundleControl({
  projectName,
  number,
}: {
  projectName?: string;
  number?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const exporting = number !== undefined;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" touch>
          {exporting ? "Export bundle" : "Import bundle"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>
          {exporting ? "Export ticket bundle" : "Import ticket bundle"}
        </DialogTitle>
        <DialogDescription>
          {exporting
            ? "Capture this ticket and its linked context for another machine. Code travels separately through Git."
            : "Choose a local project and a bundle. Import creates an independent ticket with historical documents for fresh conversations."}
        </DialogDescription>
        {open && (
          <BundleForm
            projectName={projectName}
            number={number}
            onClose={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const projects = useProjectsQuery();
  return (
    <FormGroup>
      <FormLabel>Destination project</FormLabel>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={disabled || projects.isPending}
      >
        <SelectTrigger aria-label="Destination project">
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.data?.map((project) => (
            <SelectItem key={project.name} value={project.name}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {projects.isError && (
        <FormError>
          Could not load projects.{" "}
          <button type="button" onClick={() => void projects.refetch()}>
            Retry
          </button>
        </FormError>
      )}
    </FormGroup>
  );
}

function BundleForm({
  projectName,
  number,
  onClose,
}: {
  projectName?: string;
  number?: number;
  onClose(): void;
}) {
  const fileId = useId();
  const [project, setProject] = useState(projectName ?? "");
  const [file, setFile] = useState<File | undefined>();
  const [prepared, setPrepared] = useState<BundleTransfer | null>(null);
  const prepare = usePrepareBundle();
  const proceed = useProceedBundle();
  const query = useBundleTransfer(project, prepared);
  const transfer = query.data ?? prepared;
  const running =
    transfer?.status === "preparing" || transfer?.status === "importing";
  const busy = prepare.isPending || proceed.isPending || running;
  const error = prepare.error ?? proceed.error ?? query.error;
  const prepareBundle = () => {
    proceed.reset();
    void prepare
      .mutateAsync({ project, number, file })
      .then(setPrepared)
      .catch(() => {});
  };
  const proceedBundle = (allowDuplicate: boolean) => {
    if (!transfer) return;
    void proceed
      .mutateAsync({ project, transfer, allowDuplicate })
      .catch(() => {});
  };
  return (
    <div className="flex flex-col gap-md font-mono">
      {!prepared && (
        <>
          {number === undefined && (
            <>
              <ProjectPicker
                value={project}
                onChange={setProject}
                disabled={busy}
              />
              <FormGroup>
                <FormLabel htmlFor={fileId}>Ticket bundle</FormLabel>
                <FormInput
                  id={fileId}
                  type="file"
                  accept=".gz,.cc-ticket"
                  disabled={busy}
                  onChange={(event) => setFile(event.target.files?.[0])}
                />
              </FormGroup>
            </>
          )}
          <Button
            variant="primary"
            disabled={busy || !project || (number === undefined && !file)}
            onClick={prepareBundle}
          >
            {prepare.isPending
              ? "Preparing…"
              : number === undefined
                ? "Review bundle"
                : "Prepare export"}
          </Button>
        </>
      )}
      {running && (
        <p role="status" className="m-0 text-sm text-text-secondary">
          {transfer?.status === "importing"
            ? "Importing ticket and documents…"
            : "Preparing context for review…"}
        </p>
      )}
      {transfer && (
        <TicketBundleReview
          key={transfer.id}
          transfer={transfer}
          busy={busy}
          onProceed={proceedBundle}
        />
      )}
      {transfer?.status === "failed" && <FormError>{transfer.error}</FormError>}
      {transfer?.status === "imported" && (
        <p role="status" className="m-0 text-sm text-green">
          Imported{" "}
          <Link
            href={`/tickets/${encodeURIComponent(project)}/${transfer.ticketNumber}`}
          >
            {project}#{transfer.ticketNumber}
          </Link>
        </p>
      )}
      {proceed.isSuccess && transfer?.mode === "export" && (
        <p role="status" className="m-0 text-sm text-green">
          Bundle downloaded.
        </p>
      )}
      {error && <FormError>{error.message}</FormError>}
      <DialogActions>
        {prepared && !running && (
          <Button
            variant="ghost"
            onClick={() => {
              setPrepared(null);
              prepare.reset();
              proceed.reset();
            }}
          >
            Start again
          </Button>
        )}
        {query.isError && (
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Retry status
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </div>
  );
}
