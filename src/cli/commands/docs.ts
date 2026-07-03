import { z } from "zod";
import {
  EXIT_OK,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  render,
  resolveSessionContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl docs register|list|delete` — reference-document management
 * (docs/design/cc-cli/02 §2.2). Only `list` steers the next step; `register`
 * and `delete` are deliberately hint-free (restraint is part of the convention).
 */

const DOCS_LIST_HINT =
  "register new docs with 'cctl docs register <path> --description …'; remove stale ones with 'cctl docs delete <id>'";

const documentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  description: z.string(),
  createdAt: z.string(),
});
const documentListSchema = z.array(documentSchema);
const registerResponseSchema = z.object({ document: documentSchema });

function docsPath(project: string, session: string): string {
  return `/api/projects/${encodePathSegment(project)}/sessions/${encodePathSegment(session)}/reference-documents`;
}

export async function runDocs(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "docs requires a subcommand: register, list, or delete",
      json,
    );
  }
  if (sub === "register") {
    return runDocsRegister(rest.slice(1), flags, values, env, host);
  }
  if (sub === "list") {
    return runDocsList(rest.slice(1), flags, values, env, host);
  }
  if (sub === "delete") {
    return runDocsDelete(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown docs subcommand "${sub}"`, json);
}

async function runDocsRegister(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, ["description"], json);
  if (denied) return denied;

  const filePath = rest[0];
  if (filePath === undefined) {
    return usageFailure("docs register requires a <path> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure(
      "docs register takes a single <path> argument — quote paths with spaces",
      json,
    );
  }
  const description = values["description"];
  if (description === undefined) {
    return usageFailure(
      "docs register requires --description <why it matters>",
      json,
    );
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, session, token, tokenSource } = resolved.context;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "POST",
    path: docsPath(project, session),
    body: { filePath, description },
  });

  if (result.kind !== "ok") {
    if (result.kind === "error" && result.status === 404) {
      return failure({ exitCode: EXIT_USAGE, message: result.error, json });
    }
    return failureFromRequest(result, json);
  }

  const parsed = registerResponseSchema.safeParse(result.body);
  const registeredPath = parsed.success
    ? parsed.data.document.filePath
    : filePath;
  // No hint — register is terminal (doc 02 §2.2).
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `registered ${registeredPath}\n`, {
      ok: true,
      ...(parsed.success ? { document: parsed.data.document } : {}),
    }),
    stderr: "",
  };
}

async function runDocsList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, [], json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("docs list takes no arguments", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, session, token, tokenSource } = resolved.context;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "GET",
    path: docsPath(project, session),
  });

  if (result.kind !== "ok") {
    if (result.kind === "error" && result.status === 404) {
      return failure({ exitCode: EXIT_USAGE, message: result.error, json });
    }
    return failureFromRequest(result, json);
  }

  const parsed = documentListSchema.safeParse(result.body);
  const documents = parsed.success ? parsed.data : [];
  const humanBody =
    documents.length === 0
      ? "no reference documents registered\n"
      : `${documents
          .map((d) => `${d.id}  ${d.filePath}  —  ${d.description}`)
          .join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      documents,
      hint: DOCS_LIST_HINT,
    }),
    stderr: "",
  };
}

async function runDocsDelete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, [], json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("docs delete requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("docs delete takes a single <id> argument", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const { server, project, session, token, tokenSource } = resolved.context;

  const result = await cliRequest(host, {
    server,
    token,
    tokenSource,
    method: "DELETE",
    path: `${docsPath(project, session)}/${encodePathSegment(id)}`,
  });

  if (result.kind !== "ok") {
    if (result.kind === "error" && result.status === 404) {
      // Unknown document (or session) is a caller mistake, not a server outage.
      return failure({ exitCode: EXIT_USAGE, message: result.error, json });
    }
    return failureFromRequest(result, json);
  }

  // No hint — delete is terminal.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `deleted ${id}\n`, { ok: true }),
    stderr: "",
  };
}
