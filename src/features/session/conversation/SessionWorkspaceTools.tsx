"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PublicSessionState } from "@/lib/sessions/schemas";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { useTddToggleMutation } from "@/lib/sessions/mutations";
import { useDevServers } from "@/hooks/use-dev-servers";
import { createClientLogger } from "@/lib/logging/client-logger";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/Dialog";
import { DevServerPanel } from "@/components/DevServerDrawer";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import AlignmentPanel from "./AlignmentPanel";

const log = createClientLogger("session-overview");

export default function SessionWorkspaceTools({
  projectName,
  session,
}: {
  projectName: string;
  session: PublicSessionState;
}) {
  const sessionName = session.sessionName;
  const queryClient = useQueryClient();
  const tdd = useTddToggleMutation(projectName, sessionName);
  const dev = useDevServers(projectName, sessionName);
  const [devOpen, setDevOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const enabled = tdd.isPending ? tdd.variables : session.tddEnabled;

  return (
    <div className="flex flex-col gap-lg">
      <div ref={anchor} className="flex flex-col gap-sm">
        <div className="flex items-center justify-between gap-sm text-[0.78rem] text-text-primary">
          <span>Dev servers</span>
          <span className="text-[0.7rem] text-text-secondary">
            {dev.isLoading
              ? "Loading…"
              : `${dev.servers.filter((server) => server.status === "running").length} running`}
          </span>
        </div>
        {dev.isError ? (
          <p role="alert" className="text-[0.72rem] text-red-text">
            Could not load dev servers.
          </p>
        ) : dev.servers.length > 0 ? (
          <Button
            size="sm"
            touch
            onClick={() => {
              setDevOpen(true);
              log.debug("session_overview.dev_servers_opened", {
                projectName,
                sessionName,
              });
            }}
          >
            Manage dev servers
          </Button>
        ) : (
          !dev.isLoading && (
            <p className="text-[0.72rem] leading-relaxed text-text-secondary">
              No dev servers configured.
            </p>
          )
        )}
      </div>
      <DevServerPanel
        presentation="dialog"
        open={devOpen}
        servers={dev.servers}
        anchorRef={anchor}
        onClose={() => {
          setDevOpen(false);
          anchor.current?.querySelector("button")?.focus();
        }}
        onStart={dev.startServer}
        onStop={dev.stopServer}
        onStartAll={dev.startAll}
        onStopAll={dev.stopAll}
        unmanagedConflict={dev.unmanagedConflict}
        onDismissUnmanagedConflict={dev.dismissUnmanagedConflict}
        onStopUnmanagedAndRetry={dev.stopUnmanagedAndRetry}
        isStoppingUnmanaged={dev.isStoppingUnmanaged}
      />
      <div>
        <label className="flex min-h-[44px] items-center justify-between gap-sm text-[0.78rem] text-text-primary">
          <span>Red-green TDD</span>
          <Switch
            tone="green"
            checked={enabled}
            disabled={tdd.isPending || session.finished}
            aria-label="Red-green TDD"
            onCheckedChange={(tddEnabled) => {
              log.info("session_overview.tdd_changed", {
                projectName,
                sessionName,
                tddEnabled,
              });
              tdd.mutate(tddEnabled, {
                onSuccess: () =>
                  queryClient.setQueryData<PublicSessionState>(
                    sessionKeys.detail(projectName, sessionName),
                    (current) =>
                      current ? { ...current, tddEnabled } : current,
                  ),
                onError: (error) =>
                  log.warn("session_overview.tdd_failed", {
                    projectName,
                    sessionName,
                    error: error.message,
                  }),
              });
            }}
          />
        </label>
        <p className="text-[0.7rem] leading-relaxed text-text-secondary">
          {tdd.isPending
            ? "Saving…"
            : "Test-first guidance for agents in this session."}
        </p>
        {tdd.isError && (
          <p role="alert" className="mt-sm text-[0.72rem] text-red-text">
            Could not save TDD setting. Try again.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-sm">
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" touch>
              Session alignment
            </Button>
          </DialogTrigger>
          <DialogContent size="wide" mobileSheet aria-describedby={undefined}>
            <DialogTitle>Session alignment</DialogTitle>
            <div className="max-h-[65dvh] overflow-y-auto">
              <AlignmentPanel
                projectName={projectName}
                sessionName={sessionName}
              />
            </div>
            <DialogClose asChild>
              <Button size="sm" touch layoutClassName="mt-lg">
                Close
              </Button>
            </DialogClose>
          </DialogContent>
        </Dialog>
        <Button size="sm" touch onClick={() => setCapabilitiesOpen(true)}>
          Agent capabilities
        </Button>
        <ScopedAgentCapabilitiesConfig
          level="session"
          projectName={projectName}
          sessionName={sessionName}
          renderTrigger={false}
          open={capabilitiesOpen}
          onOpenChange={setCapabilitiesOpen}
        />
      </div>
    </div>
  );
}
