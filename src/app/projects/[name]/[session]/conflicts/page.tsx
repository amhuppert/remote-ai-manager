"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import MergeConflictsPage from "@/features/session/dialogs/MergeConflictsPage";
import { useResolveConflictsMutation } from "@/lib/git/mutations";
import { useConflictsQuery } from "@/lib/git/queries";
import { useSessionQuery } from "@/lib/sessions/queries";

export default function ConflictsPage() {
  const params = useParams<{ name: string; session: string }>();
  const router = useRouter();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);

  const resolveConflicts = useResolveConflictsMutation(
    projectName,
    sessionName,
  );
  const conflictsQuery = useConflictsQuery(projectName, sessionName);
  const sessionQuery = useSessionQuery(projectName, sessionName);

  const [submissionError, setSubmissionError] = useState<string | null>(null);

  const conflicts = useMemo(
    () => conflictsQuery.data?.conflicts ?? [],
    [conflictsQuery.data?.conflicts],
  );
  const branchName = sessionQuery.data?.branchName ?? "";
  const targetBranch = sessionQuery.data?.targetBranch ?? "main";
  const loading = conflictsQuery.isLoading || sessionQuery.isLoading;
  const error = useMemo(() => {
    if (conflictsQuery.error) return "Failed to load conflicts";
    if (conflictsQuery.data === null) {
      return "No conflict analysis found for this session";
    }
    return null;
  }, [conflictsQuery.error, conflictsQuery.data]);

  const handleAcceptAll = useCallback(() => {
    setSubmissionError(null);
    resolveConflicts.mutate(
      conflicts.map((c) => ({ file: c.file, decision: "approved" as const })),
      {
        onSuccess: () => {
          router.push(
            `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
          );
        },
        onError: () =>
          setSubmissionError("Failed to submit conflict resolution"),
      },
    );
  }, [conflicts, resolveConflicts, router, projectName, sessionName]);

  const handleFixApproved = useCallback(
    (
      decisions: Array<{
        file: string;
        decision: string;
        feedback: string;
      }>,
    ) => {
      setSubmissionError(null);
      resolveConflicts.mutate(
        decisions.map((d) => ({
          file: d.file,
          decision: d.decision,
          ...(d.feedback ? { feedback: d.feedback } : {}),
        })),
        {
          onSuccess: () => {
            router.push(
              `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            );
          },
          onError: () =>
            setSubmissionError("Failed to submit conflict resolution"),
        },
      );
    },
    [resolveConflicts, router, projectName, sessionName],
  );

  const handleBack = useCallback(() => {
    router.push(
      `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
    );
  }, [router, projectName, sessionName]);

  if (loading) {
    return (
      <div className="app">
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">Loading conflicts...</div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <MergeConflictsPage
      projectName={projectName}
      sessionName={sessionName}
      branchName={branchName}
      targetBranch={targetBranch}
      conflicts={conflicts}
      error={error || submissionError}
      onAcceptAll={handleAcceptAll}
      onFixApproved={handleFixApproved}
      onBack={handleBack}
    />
  );
}
