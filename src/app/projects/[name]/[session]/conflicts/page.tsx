"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import MergeConflictsPage from "../MergeConflictsPage";
import { useResolveConflictsMutation } from "@/lib/mutations";
import type { ConflictEntry, SessionState } from "@/types";

export default function ConflictsPage() {
  const params = useParams<{ name: string; session: string }>();
  const router = useRouter();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);

  const resolveConflicts = useResolveConflictsMutation(
    projectName,
    sessionName,
  );

  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch conflict analysis and session data in parallel
  useEffect(() => {
    async function fetchData() {
      try {
        const conflictsUrl = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conflicts`;
        const sessionUrl = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}`;

        const [conflictsRes, sessionRes] = await Promise.all([
          fetch(conflictsUrl),
          fetch(sessionUrl),
        ]);

        // Handle conflict analysis response
        if (!conflictsRes.ok) {
          if (conflictsRes.status === 404) {
            setError("No conflict analysis found for this session");
          } else {
            setError("Failed to load conflicts");
          }
          return;
        }

        const conflictData = (await conflictsRes.json()) as {
          conflicts?: ConflictEntry[];
          jobId?: string;
        };
        setConflicts(conflictData.conflicts ?? []);

        // Extract branch name from session data
        if (sessionRes.ok) {
          const sessionData = (await sessionRes.json()) as SessionState;
          setBranchName(sessionData.branchName);
        }
      } catch {
        setError("Failed to load conflicts");
      } finally {
        setLoading(false);
      }
    }
    void fetchData();
  }, [projectName, sessionName]);

  const handleAcceptAll = useCallback(() => {
    resolveConflicts.mutate(
      conflicts.map((c) => ({ file: c.file, decision: "approved" as const })),
      {
        onSuccess: () => {
          router.push(
            `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
          );
        },
        onError: () => setError("Failed to submit conflict resolution"),
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
          onError: () => setError("Failed to submit conflict resolution"),
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

  if (error) {
    return (
      <div className="app">
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">{error}</div>
            <button className="btn btn-sm" onClick={handleBack}>
              Back to session
            </button>
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
      conflicts={conflicts}
      onAcceptAll={handleAcceptAll}
      onFixApproved={handleFixApproved}
      onBack={handleBack}
    />
  );
}
