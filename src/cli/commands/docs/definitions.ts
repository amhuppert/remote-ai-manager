import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

export const docsRegisterSpec = {
  path: "docs register",
  summary: "Register or update a reference document",
  description:
    "Register a file inside this session worktree. Registering its path again updates the description in place.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "path",
      description: "Document path inside the session worktree",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: {
    description: {
      description: "When and why agents should read the document",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
  },
  related: [
    { path: "docs list", description: "List registered documents" },
    { path: "docs delete", description: "Remove a registered document" },
  ],
} as const;

export const docsListSpec = {
  path: "docs list",
  summary: "List registered reference documents",
  description:
    "Read this session's reference documents with their immutable ids, paths, and descriptions. Large results are delivered as an artifact.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  related: [
    { path: "docs register", description: "Register another document" },
    { path: "docs delete", description: "Remove a registered document" },
  ],
} as const;

export const docsDeleteSpec = {
  path: "docs delete",
  summary: "Deregister a reference document and remove its file",
  description:
    "Delete the reference document named by the id printed by docs list, including its file on disk.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "id",
      description: "Reference document id",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: {},
  related: [
    { path: "docs list", description: "Find a registered document id" },
    { path: "docs register", description: "Register a document" },
  ],
} as const;

export const docsRegisterCommand = ccCommands.defineCommand(docsRegisterSpec, {
  examples: [
    {
      args: { path: "docs/design.md" },
      flags: { description: "Read before changing the API" },
      why: "Register an API design document",
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).registerHandler,
  }),
});
export const docsListCommand = ccCommands.defineCommand(docsListSpec, {
  examples: [{ why: "Find the document ids registered in this session" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const docsDeleteCommand = ccCommands.defineCommand(docsDeleteSpec, {
  examples: [
    { args: { id: "doc-one" }, why: "Remove a stale reference document" },
  ],
  handler: async () => ({
    default: (await import("./handlers")).deleteHandler,
  }),
});

export const docsCommands = [
  docsRegisterCommand,
  docsListCommand,
  docsDeleteCommand,
] as const;
export const docsGroups = [
  defineGroup({
    path: "docs",
    summary: "Manage this session's reference documents",
    description:
      "Register, list, and remove files that other conversations should read.",
  }),
] as const;
