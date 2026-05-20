import { getProjectSessionListItems, getProjectSessions } from "@/lib/state";

const projectPath = "/home/alex/projects/test-workflow";

const slimStart = Date.now();
const slim = await getProjectSessionListItems(projectPath);
const slimMs = Date.now() - slimStart;
const slimBytes = JSON.stringify({ sessions: slim }).length;

const fullStart = Date.now();
const full = await getProjectSessions(projectPath);
const fullMs = Date.now() - fullStart;
const fullBytes = JSON.stringify({ sessions: full }).length;

const forbidden = [
  "machineSnapshot",
  "graphWorkflowExecution",
  "graphWorkflowExecutionHistory",
  "workflowEnvelopes",
  "workflowLanes",
  "conversations",
  "referenceDocuments",
  "mcpRuntime",
  "agentCapabilitiesRuntime",
  "pendingQuestions",
  "pendingPromptText",
  "debugMode",
];
const slimJson = JSON.stringify(slim);
const leakedFields = forbidden.filter((f) => slimJson.includes(`"${f}"`));

const firstKeys = slim[0] ? Object.keys(slim[0]).sort() : [];

console.log(
  JSON.stringify(
    {
      sessionsCount: slim.length,
      slimBytes,
      fullBytes,
      reductionRatio: (fullBytes / Math.max(1, slimBytes)).toFixed(1) + "x",
      slimMs,
      fullMs,
      leakedFields,
      firstKeys,
      sample: slim[0],
    },
    null,
    2,
  ),
);
