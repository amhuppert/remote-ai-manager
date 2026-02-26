"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import MergeConflictsPage from "../MergeConflictsPage";
import { useAddOrUpdateJob } from "@/stores/notification.store";
import type { ConflictEntry, JobDispatchResponse, SessionState } from "@/types";

export default function ConflictsPage() {
  const params = useParams<{ name: string; session: string }>();
  const router = useRouter();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);

  const addOrUpdateJob = useAddOrUpdateJob();

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

  const handleAcceptAll = useCallback(async () => {
    try {
      const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/resolve-conflicts`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: conflicts.map((c) => ({
            file: c.file,
            decision: "approved" as const,
          })),
        }),
      });
      if (res.status === 202) {
        const data = (await res.json()) as JobDispatchResponse;
        addOrUpdateJob({
          type: "job-status",
          jobType: data.jobType,
          status: "running",
          projectName,
          sessionName,
          jobId: data.jobId,
          branchName: data.branchName,
        });
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
        );
      }
    } catch {
      setError("Failed to submit conflict resolution");
    }
  }, [projectName, sessionName, conflicts, router, addOrUpdateJob]);

  const handleFixApproved = useCallback(
    async (
      decisions: Array<{
        file: string;
        decision: string;
        feedback: string;
      }>,
    ) => {
      try {
        const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/resolve-conflicts`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisions: decisions.map((d) => ({
              file: d.file,
              decision: d.decision,
              ...(d.feedback ? { feedback: d.feedback } : {}),
            })),
          }),
        });
        if (res.status === 202) {
          const data = (await res.json()) as JobDispatchResponse;
          addOrUpdateJob({
            type: "job-status",
            jobType: data.jobType,
            status: "running",
            projectName,
            sessionName,
            jobId: data.jobId,
            branchName: data.branchName,
          });
          router.push(
            `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
          );
        }
      } catch {
        setError("Failed to submit conflict resolution");
      }
    },
    [projectName, sessionName, router, addOrUpdateJob],
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
