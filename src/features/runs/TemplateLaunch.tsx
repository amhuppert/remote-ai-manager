"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useConversationsQuery } from "@/lib/conversations/queries";
import {
  launchRefusalOf,
  useLaunchRunTemplateMutation,
} from "@/lib/run-templates/mutations";
import { runsPageHref } from "@/lib/runs/hrefs";
import { useSessionQuery } from "@/lib/sessions/queries";
import {
  LaunchDialog,
  type LaunchableTemplate,
} from "./components/template/LaunchDialog";
import { ownerChoicesOf } from "./owner-choices";

/**
 * A template launch from a session's pages: the dialog, the session's owner
 * choices, and the launch. The dialog shows the launch pending; a launched
 * run opens its page; a refusal stays in the dialog, at its parameter when it
 * names one.
 */
export function TemplateLaunchDialog({
  projectName,
  sessionName,
  template,
  onClose,
}: {
  projectName: string;
  sessionName: string;
  /** The template to launch; null while none is being launched. */
  template: LaunchableTemplate | null;
  onClose(): void;
}) {
  // The owner reads start when a launch opens, not with the page.
  if (template === null) return null;
  return (
    <OpenLaunch
      projectName={projectName}
      sessionName={sessionName}
      template={template}
      onClose={onClose}
    />
  );
}

function OpenLaunch({
  projectName,
  sessionName,
  template,
  onClose,
}: {
  projectName: string;
  sessionName: string;
  template: LaunchableTemplate;
  onClose(): void;
}) {
  const router = useRouter();
  const conversations = useConversationsQuery(projectName, sessionName);
  const session = useSessionQuery(projectName, sessionName);
  const launch = useLaunchRunTemplateMutation(projectName, sessionName);
  const owners = useMemo(
    () =>
      ownerChoicesOf(conversations.data ?? [], session.data?.archived ?? false),
    [conversations.data, session.data?.archived],
  );
  // One refusal object per failed launch: the dialog dismisses it by identity.
  const refusal = useMemo(
    () => (launch.error === null ? null : launchRefusalOf(launch.error)),
    [launch.error],
  );
  return (
    <LaunchDialog
      open
      template={template}
      sessionName={sessionName}
      owners={owners}
      submitting={launch.isPending}
      refusal={refusal}
      onOpenChange={(open) => {
        if (open || launch.isPending) return;
        onClose();
      }}
      onLaunch={(request) =>
        launch.mutate(request, {
          onSuccess: (receipt) =>
            router.push(runsPageHref(projectName, sessionName, receipt.runId)),
        })
      }
    />
  );
}
