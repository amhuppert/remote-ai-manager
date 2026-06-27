"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AlignmentPanelView from "@/features/session/conversation/AlignmentPanelView";
import {
  useAlignmentStateQuery,
  useAlignmentDiffQuery,
} from "@/lib/session-alignment/queries";
import { useRollbackAlignmentMutation } from "@/lib/session-alignment/mutations";
import { conversationsPageHref } from "@/lib/conversations/hrefs";

interface AlignmentPanelProps {
  projectName: string;
  sessionName: string;
}

/**
 * Container for the alignment surface, mounted as a tab in the existing documents
 * right pane — reusing that surface rather than adding a parallel registry (R9.2).
 * The per-version diff query stays disabled until the user picks a version pair so
 * opening the panel costs only the single alignment-state fetch.
 */
export default function AlignmentPanel({
  projectName,
  sessionName,
}: AlignmentPanelProps): React.JSX.Element {
  const router = useRouter();
  const [diffPair, setDiffPair] = useState<{ from: number; to: number } | null>(
    null,
  );

  const stateQuery = useAlignmentStateQuery(projectName, sessionName);
  const diffQuery = useAlignmentDiffQuery(
    projectName,
    sessionName,
    diffPair?.from ?? 0,
    diffPair?.to ?? 0,
    diffPair !== null,
  );
  const rollback = useRollbackAlignmentMutation(projectName, sessionName);

  return (
    <AlignmentPanelView
      state={stateQuery.data ?? null}
      isLoading={stateQuery.isPending}
      diff={diffPair ? (diffQuery.data ?? null) : null}
      onSelectDiff={(from, to) => setDiffPair({ from, to })}
      onRollback={(version) => rollback.mutate({ version })}
      onNavigateToMessage={(conversationId, messageId) =>
        router.push(conversationsPageHref({ conversationId, messageId }))
      }
    />
  );
}
