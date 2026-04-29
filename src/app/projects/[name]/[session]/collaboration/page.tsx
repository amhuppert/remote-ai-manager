"use client";

import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import Topbar from "@/components/Topbar";
import { useCollaborationListQuery } from "@/lib/queries";
import {
  useCollaborationResumeMutation,
  useCollaborationStartMutation,
} from "@/lib/mutations";
import {
  useBriefDraft,
  useClearBriefDraft,
  useClearUserAnswerDrafts,
  useSelectedWorkflowId,
  useSetBriefDraft,
  useSetSelectedWorkflowId,
  useSetUserAnswerDraft,
  useUserAnswerDrafts,
} from "@/stores/collaboration.store";
import type { CollaborationEnvelopeView } from "@/lib/api-client";
import { CollaborationStatusCard } from "./CollaborationStatusCard";

interface OpenQuestion {
  question: string;
  requiresUserInput: boolean;
}

function readPriorRoundOpenQuestions(
  envelope: CollaborationEnvelopeView,
): OpenQuestion[] {
  const snapshot = envelope.featureSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [];
  }
  const transcript = (snapshot as Record<string, unknown>)["transcript"];
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  const lastRound = transcript[transcript.length - 1];
  if (!Array.isArray(lastRound)) return [];
  const collected: OpenQuestion[] = [];
  for (const entry of lastRound) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const oq = (entry as Record<string, unknown>)["openQuestions"];
      if (Array.isArray(oq)) {
        for (const q of oq) {
          if (
            q &&
            typeof q === "object" &&
            typeof (q as Record<string, unknown>)["question"] === "string" &&
            typeof (q as Record<string, unknown>)["requiresUserInput"] ===
              "boolean"
          ) {
            collected.push({
              question: (q as Record<string, unknown>)["question"] as string,
              requiresUserInput: (q as Record<string, unknown>)[
                "requiresUserInput"
              ] as boolean,
            });
          }
        }
      }
    }
  }
  return collected.filter((q) => q.requiresUserInput);
}

export default function CollaborationPage(): React.JSX.Element {
  const params = useParams<{ name: string; session: string }>();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const draft = useBriefDraft(projectName, sessionName);
  const setDraft = useSetBriefDraft();
  const clearDraft = useClearBriefDraft();
  const selectedWorkflowId = useSelectedWorkflowId(projectName, sessionName);
  const setSelectedWorkflowId = useSetSelectedWorkflowId();

  const listQuery = useCollaborationListQuery(projectName, sessionName, {
    refetchInterval: 3000,
    includeAll: true,
  });

  const startMutation = useCollaborationStartMutation(projectName, sessionName);

  const handleStart = useCallback(() => {
    if (draft.brief.trim().length === 0) return;
    startMutation.mutate(
      {
        brief: draft.brief.trim(),
        maxIterations: draft.maxIterations,
        scribeBackend: draft.scribeBackend,
      },
      {
        onSuccess: () => {
          clearDraft(projectName, sessionName);
        },
      },
    );
  }, [draft, startMutation, clearDraft, projectName, sessionName]);

  const envelopes = listQuery.data ?? [];
  const selected = selectedWorkflowId
    ? envelopes.find((e) => e.workflowId === selectedWorkflowId)
    : null;

  return (
    <div className="app" data-page="collaboration">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
          {
            label: "Collaboration",
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/collaboration`,
          },
        ]}
      />

      <main className="main collaboration-page">
        <section
          className="collaboration-page-start"
          data-testid="collaboration-start-form"
        >
          <h2>Start a collaboration run</h2>
          <label className="collaboration-page-field">
            Brief
            <textarea
              value={draft.brief}
              onChange={(e) =>
                setDraft(projectName, sessionName, { brief: e.target.value })
              }
              placeholder="Describe what should be designed..."
              rows={4}
            />
          </label>
          <div className="collaboration-page-row">
            <label className="collaboration-page-field">
              Max iterations
              <input
                type="number"
                min={1}
                max={20}
                value={draft.maxIterations}
                onChange={(e) =>
                  setDraft(projectName, sessionName, {
                    maxIterations: Math.max(
                      1,
                      Math.min(20, Number(e.target.value) || 1),
                    ),
                  })
                }
              />
            </label>
            <label className="collaboration-page-field">
              Scribe
              <select
                value={draft.scribeBackend}
                onChange={(e) =>
                  setDraft(projectName, sessionName, {
                    scribeBackend: e.target.value as "claude" | "codex",
                  })
                }
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={
              startMutation.isPending || draft.brief.trim().length === 0
            }
            onClick={handleStart}
            data-testid="collaboration-start-button"
          >
            {startMutation.isPending ? "Starting..." : "Start collaboration"}
          </button>
          {startMutation.isError ? (
            <p className="collaboration-page-error">
              Failed to start: {String(startMutation.error)}
            </p>
          ) : null}
        </section>

        <section className="collaboration-page-list">
          <h2>Recent runs</h2>
          {listQuery.isPending ? (
            <p>Loading...</p>
          ) : envelopes.length === 0 ? (
            <p className="collaboration-page-empty">
              No collaboration runs yet.
            </p>
          ) : (
            <div className="collaboration-page-grid">
              {envelopes.map((env) => (
                <CollaborationStatusCard
                  key={env.workflowId}
                  envelope={env}
                  isSelected={selectedWorkflowId === env.workflowId}
                  onSelect={(id) =>
                    setSelectedWorkflowId(projectName, sessionName, id)
                  }
                />
              ))}
            </div>
          )}
        </section>

        {selected ? (
          <CollaborationDetailPanel
            envelope={selected}
            projectName={projectName}
            sessionName={sessionName}
          />
        ) : null}
      </main>
    </div>
  );
}

function CollaborationDetailPanel(props: {
  envelope: CollaborationEnvelopeView;
  projectName: string;
  sessionName: string;
}): React.JSX.Element {
  const { envelope, projectName, sessionName } = props;
  const drafts = useUserAnswerDrafts(
    projectName,
    sessionName,
    envelope.workflowId,
  );
  const setDraft = useSetUserAnswerDraft();
  const clearDrafts = useClearUserAnswerDrafts();
  const resumeMutation = useCollaborationResumeMutation(
    projectName,
    sessionName,
    envelope.workflowId,
  );
  const [showRecovery, setShowRecovery] = useState(false);

  const openQuestions = readPriorRoundOpenQuestions(envelope);

  const handleResume = useCallback(() => {
    if (!envelope.pause?.resumeToken) return;
    const userAnswers: Record<string, string> = {};
    for (const q of openQuestions) {
      const answer = drafts[q.question];
      if (typeof answer === "string" && answer.trim().length > 0) {
        userAnswers[q.question] = answer.trim();
      }
    }
    resumeMutation.mutate(
      { resumeToken: envelope.pause.resumeToken, userAnswers },
      {
        onSuccess: () => {
          clearDrafts(projectName, sessionName, envelope.workflowId);
        },
      },
    );
  }, [
    envelope,
    openQuestions,
    drafts,
    resumeMutation,
    clearDrafts,
    projectName,
    sessionName,
  ]);

  const isRecoveryPause =
    envelope.status === "paused" &&
    envelope.pause?.resumeToken?.startsWith("recovery-") === true;

  return (
    <section
      className="collaboration-page-detail"
      data-testid="collaboration-detail"
    >
      <header className="collaboration-page-detail-header">
        <h3>Workflow {envelope.workflowId}</h3>
        <span>{envelope.status}</span>
      </header>

      {envelope.status === "paused" && envelope.pause ? (
        <div className="collaboration-page-resume">
          {isRecoveryPause ? (
            <>
              <p className="collaboration-page-recovery">
                This run was paused by a process restart. Resume to continue
                from the last completed round.
              </p>
              <button
                type="button"
                onClick={handleResume}
                disabled={resumeMutation.isPending}
                data-testid="collaboration-recovery-resume"
              >
                {resumeMutation.isPending ? "Resuming..." : "Resume"}
              </button>
            </>
          ) : (
            <>
              {openQuestions.length > 0 ? (
                <div className="collaboration-page-questions">
                  <h4>Open questions</h4>
                  {openQuestions.map((q) => (
                    <label
                      key={q.question}
                      className="collaboration-page-field"
                    >
                      {q.question}
                      <input
                        type="text"
                        value={drafts[q.question] ?? ""}
                        onChange={(e) =>
                          setDraft(
                            projectName,
                            sessionName,
                            envelope.workflowId,
                            q.question,
                            e.target.value,
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p>Awaiting human approval.</p>
              )}
              <button
                type="button"
                onClick={handleResume}
                disabled={resumeMutation.isPending}
                data-testid="collaboration-resume-button"
              >
                {resumeMutation.isPending ? "Resuming..." : "Resume"}
              </button>
            </>
          )}
        </div>
      ) : null}

      {envelope.status === "completed" ? (
        <CollaborationArtifactsList envelope={envelope} />
      ) : null}

      {envelope.status === "failed" && envelope.errorSummary ? (
        <>
          <p className="collaboration-page-error">{envelope.errorSummary}</p>
          <button type="button" onClick={() => setShowRecovery((v) => !v)}>
            {showRecovery ? "Hide details" : "Show recovery details"}
          </button>
        </>
      ) : null}
    </section>
  );
}

function CollaborationArtifactsList(props: {
  envelope: CollaborationEnvelopeView;
}): React.JSX.Element {
  const { envelope } = props;
  const params = useParams<{ name: string; session: string }>();
  const snapshot = envelope.featureSnapshot;
  const reader = (key: string): string | undefined => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return undefined;
    }
    const value = (snapshot as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const merged = reader("mergedDesignArtifactId");
  const transcript = reader("transcriptArtifactId");
  const open = reader("openQuestionsArtifactId");

  const artifactHref = (type: string): string =>
    `/api/projects/${encodeURIComponent(params.name)}/sessions/${encodeURIComponent(params.session)}/collaboration/${encodeURIComponent(envelope.workflowId)}/artifacts/${type}`;

  return (
    <ul className="collaboration-page-artifacts">
      {merged ? (
        <li data-artifact="merged-design">
          <a
            href={artifactHref("merged-design")}
            target="_blank"
            rel="noreferrer"
          >
            Merged design
          </a>
        </li>
      ) : null}
      {transcript ? (
        <li data-artifact="transcript">
          <a href={artifactHref("transcript")} target="_blank" rel="noreferrer">
            Transcript
          </a>
        </li>
      ) : null}
      {open ? (
        <li data-artifact="open-questions">
          <a
            href={artifactHref("open-questions")}
            target="_blank"
            rel="noreferrer"
          >
            Open questions
          </a>
        </li>
      ) : null}
    </ul>
  );
}
