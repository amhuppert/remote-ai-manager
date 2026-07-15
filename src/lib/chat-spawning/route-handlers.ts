import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/shared/errors";
import { notFound, resolveProjectOr404 } from "@/lib/shared/route-resolution";
import {
  resolveProjectPath as defaultResolveProjectPath,
  getProjectDisplayName as defaultGetProjectDisplayName,
} from "@/lib/projects/resolver";
import { getProjectConversation as defaultGetProjectConversation } from "@/lib/state-store";
import { createLogger } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import { spawnProposalSchema, type SpawnResult } from "./schemas";
import {
  createChatSpawnService,
  defaultChatSpawnDeps,
  type CreateFromProposalInput,
} from "./spawn-service";

const logger = createLogger("chat-spawning.routes");

type RouteContext = { params: Promise<Record<string, string>> };

export interface SpawnRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  createFromProposal(input: CreateFromProposalInput): Promise<SpawnResult>;
}

function defaultSpawnRouteDeps(): SpawnRouteDeps {
  const service = createChatSpawnService(defaultChatSpawnDeps());
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getProjectDisplayName: defaultGetProjectDisplayName,
    getProjectConversation: defaultGetProjectConversation,
    createFromProposal: service.createFromProposal,
  };
}

/**
 * POST /api/projects/[name]/conversations/[conversationId]/spawn
 *
 * Validates the (edited) proposal as untrusted input (`safeParse` → 400),
 * asserts the project + PLC exist (404), then delegates to the deterministic
 * spawn service. A partial batch still returns 200 with populated `failed[]` —
 * only a malformed body or unknown project/PLC is a non-2xx.
 */
export function createSpawnRouteHandlers(
  deps: SpawnRouteDeps = defaultSpawnRouteDeps(),
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const params = await context.params;
    const name = params["name"] ?? "";
    const conversationId = params["conversationId"] ?? "";

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const plc = await deps.getProjectConversation(projectPath, conversationId);
    if (!plc) {
      return notFound("Project conversation not found");
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = spawnProposalSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      });
      return NextResponse.json(
        {
          error: "Invalid spawn proposal",
          details: { issues },
        } satisfies ApiError,
        { status: 400 },
      );
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const result = await deps.createFromProposal({
        projectPath,
        projectName,
        conversationId,
        proposal: parsed.data,
      });
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      logger.error("chat-spawning.route_failure", {
        projectName,
        conversationId,
        error: getErrorMessage(err),
      });
      return NextResponse.json(
        { error: "Failed to spawn sessions" } satisfies ApiError,
        { status: 500 },
      );
    }
  }

  return { POST };
}

const _handlers = createSpawnRouteHandlers();
export const spawnSessionsPOST = _handlers.POST;
