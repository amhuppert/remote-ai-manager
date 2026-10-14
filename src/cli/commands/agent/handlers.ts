import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  runner,
  type CommandSpec,
  type HandlerInput,
  type ReadHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import {
  agentProfileLibraryEntrySchema,
  agentProfileLibraryListingSchema,
  formatAgentProfileRef,
  parseAgentProfileRef,
  type AgentProfileLibraryEntry,
  type AgentProfileLibraryListing,
} from "@/lib/agent-profiles/schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcProject,
  type CcErrorCode,
} from "../../framework/context";
import { ccRequestFailure } from "../../framework/request";
import {
  cliRequest,
  encodePathSegment,
  type ProjectContext,
} from "../../transport";
import {
  agentGetCommand,
  agentListCommand,
  type agentListSpec,
  type agentGetSpec,
} from "./definitions";

type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
const invalid = (message: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  }) as const;
function profilesPath(context: ProjectContext) {
  return `/api/projects/${encodePathSegment(context.project)}/agent-profiles`;
}
export const listHandler: Read<typeof agentListSpec> = {
  run: runner<
    Input<typeof agentListSpec>,
    AgentProfileLibraryListing,
    CcErrorCode
  >({
    async run({ app }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: profilesPath(resolved.value),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = agentProfileLibraryListingSchema.safeParse(response.body);
      if (!parsed.success)
        return invalid("The agent profile listing is invalid.");
      const first = parsed.data.profiles[0];
      return {
        ok: true,
        data: parsed.data,
        ...(first
          ? {
              hint: hint(
                invocation(agentGetCommand, {
                  flags: explicitScopeFlags(app),
                  args: { profile: formatAgentProfileRef(first.ref) },
                }),
                "Read profile instructions",
              ),
            }
          : {}),
      };
    },
    text: ({ profiles, diagnostics }) =>
      quoteLiteralText(
        [
          `${profiles.length} agent profiles`,
          ...profiles.flatMap((profile) => [
            `${formatAgentProfileRef(profile.ref)} (rev ${profile.revision}) ${profile.name} — ${profile.description}`,
            `  for: ${profile.recommendedFor.join(", ") || "any"}; tags: ${profile.tags.join(", ") || "none"}${profile.readOnly ? "; read-only" : ""}`,
          ]),
          ...(diagnostics.length
            ? [
                "Unreadable records (quarantined):",
                ...diagnostics.map(
                  (item) => `${item.tier}:${item.id} — ${item.reason}`,
                ),
              ]
            : []),
        ].join("\n") + "\n",
      ),
  }),
};
export const getHandler: Read<typeof agentGetSpec> = {
  run: runner<
    Input<typeof agentGetSpec>,
    { profile: AgentProfileLibraryEntry },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const ref = parseAgentProfileRef(ctx.args.profile);
      if (!ref.ok)
        return {
          ok: false,
          error: ccErrors.error("CC_USAGE", {
            message: ref.failure.message,
            details: { ...ref.failure },
          }),
          hint: hint(
            invocation(agentListCommand, { flags: explicitScopeFlags(app) }),
            "List qualified references",
          ),
        };
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${profilesPath(resolved.value)}/${encodePathSegment(ref.ref.tier)}/${encodePathSegment(ref.ref.id)}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = agentProfileLibraryEntrySchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: { profile: parsed.data } }
        : invalid("The agent profile response is invalid.");
    },
    text: ({ profile }) =>
      quoteLiteralText(
        `${profile.tier}:${profile.id} (rev ${profile.revision}) ${profile.name}\n${profile.description}\nfor: ${profile.recommendedFor.join(", ") || "any"}; tags: ${profile.tags.join(", ") || "none"}${profile.readOnly ? "; read-only" : ""}\n\n${profile.instructions}\n`,
      ),
  }),
};
