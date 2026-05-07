#!/usr/bin/env -S tsx
/**
 * Seed a fresh `command-center.db` with a production-equivalent corpus for the
 * post-cutover parallel-x6 measurement (Requirement 9.1).
 *
 * The script writes only via the per-entity repos so every row passes through
 * the canonical Zod schemas at the boundary.
 *
 * Usage:
 *   CC_CONFIG_DIR=/tmp/cc-bench-cutover-XXXX tsx scripts/bench-cutover-seed.ts
 *
 * Required env:
 *   CC_CONFIG_DIR — must already be set to the temp config dir before this
 *                   script imports the state-store singleton.
 *
 * The script prints a JSON line on the last stdout line containing the target
 * project/session/conversation that the harness should hit with /diff.
 */
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

if (!process.env["CC_CONFIG_DIR"]) {
  console.error(
    "bench-cutover-seed: CC_CONFIG_DIR must be set before invoking this script",
  );
  process.exit(2);
}

const configDir = process.env["CC_CONFIG_DIR"]!;
mkdirSync(configDir, { recursive: true });

// Write a config.json so the dev server's project-resolver has a stable baseDir.
const baseDir = "/home/alex/github";
const configFile = path.join(configDir, "config.json");
if (!existsSync(configFile)) {
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        baseDir,
        ignorePatterns: ["node_modules", ".next", "dist", "build", ".cache"],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

import {
  sessionStateSchema,
  conversationStateSchema,
} from "../src/lib/schemas";
import { getStateDb } from "../src/lib/state-store/state-store";
import { createProjectsRepo } from "../src/lib/state-store/projects-repo";
import { createSessionsRepo } from "../src/lib/state-store/sessions-repo";
import { createConversationsRepo } from "../src/lib/state-store/conversations-repo";

const TARGET_BASE_DIR = baseDir;
const TARGET_PROJECT_NAME = "remote-ai-manager";
const TARGET_PROJECT_PATH = path.join(TARGET_BASE_DIR, TARGET_PROJECT_NAME);
const TARGET_SESSION_NAME = "state-persistence-optimization-090c25";
const TARGET_WORKTREE_PATH = path.join(
  TARGET_PROJECT_PATH,
  ".worktrees",
  TARGET_SESSION_NAME,
);

const ADDITIONAL_PROJECTS = [
  "active-recall",
  "task-garden",
  "Shpadoinkle-snowman",
  "advent-of-code",
  "ai-prompt-templates",
  "claude-code",
];

const SESSIONS_PER_PROJECT = 28;
const CONVERSATIONS_PER_SESSION = 4;

const ISO_BASE = new Date("2026-01-01T00:00:00Z").getTime();

function iso(offsetMs: number): string {
  return new Date(ISO_BASE + offsetMs).toISOString();
}

function makeSession(projectPath: string, idx: number) {
  const name = `bench-${path.basename(projectPath)}-${idx}`;
  return sessionStateSchema.parse({
    sessionName: name,
    worktreePath: `/tmp/bench-fake-worktrees/${path.basename(projectPath)}/${name}`,
    branchName: `csm/${name}`,
    createdAt: iso(idx * 1_000),
    lastActivityAt: iso(idx * 1_000 + 500),
  });
}

function makeConversation(idx: number, suffix: string) {
  return conversationStateSchema.parse({
    id: `bench-conv-${suffix}-${idx}`,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: iso(idx * 100),
    lastActivityAt: iso(idx * 100 + 50),
  });
}

const db = getStateDb();
const projects = createProjectsRepo(db);
const sessions = createSessionsRepo(db);
const conversations = createConversationsRepo(db);

const allProjectPaths = [
  TARGET_PROJECT_PATH,
  ...ADDITIONAL_PROJECTS.map((n) => path.join(TARGET_BASE_DIR, n)),
];

let totalSessions = 0;
let totalConversations = 0;

const seedTx = db.transaction(() => {
  for (const projectPath of allProjectPaths) {
    projects.upsert({ rootPath: projectPath });

    if (projectPath === TARGET_PROJECT_PATH) {
      const target = sessionStateSchema.parse({
        sessionName: TARGET_SESSION_NAME,
        worktreePath: TARGET_WORKTREE_PATH,
        branchName: `cc/${TARGET_SESSION_NAME}`,
        createdAt: iso(0),
        lastActivityAt: iso(1_000),
      });
      sessions.upsert(projectPath, target);
      totalSessions += 1;
      for (let c = 0; c < CONVERSATIONS_PER_SESSION; c++) {
        conversations.upsert(
          projectPath,
          TARGET_SESSION_NAME,
          makeConversation(c, TARGET_SESSION_NAME),
        );
        totalConversations += 1;
      }
    }

    for (let s = 0; s < SESSIONS_PER_PROJECT; s++) {
      const session = makeSession(projectPath, s);
      sessions.upsert(projectPath, session);
      totalSessions += 1;
      for (let c = 0; c < CONVERSATIONS_PER_SESSION; c++) {
        conversations.upsert(
          projectPath,
          session.sessionName,
          makeConversation(c, session.sessionName),
        );
        totalConversations += 1;
      }
    }
  }
});
seedTx();

console.log(
  JSON.stringify({
    configDir,
    projectCount: allProjectPaths.length,
    sessionCount: totalSessions,
    conversationCount: totalConversations,
    targetProjectName: TARGET_PROJECT_NAME,
    targetSessionName: TARGET_SESSION_NAME,
    targetWorktreePath: TARGET_WORKTREE_PATH,
  }),
);
