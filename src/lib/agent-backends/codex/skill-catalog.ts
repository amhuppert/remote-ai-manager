import { z } from "zod";
import path from "node:path";
import type { AppServerClient } from "./app-server-client";
import type { CommandItem } from "@/lib/commands/schemas";
import { parseSkillReferences } from "@/lib/commands/skill-reference";

export interface CodexSkillInput {
  type: "skill";
  name: string;
  path: string;
}

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  path: z.string().refine(path.isAbsolute),
  scope: z.enum(["user", "repo", "system", "admin"]),
  enabled: z.boolean(),
  pluginId: z.string().nullable().optional(),
});
const listSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(skillSchema),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});
type Skill = z.infer<typeof skillSchema>;

/** A process-local catalog: invalidation cannot make an older request current. */
export class CodexSkillCatalog {
  private generation = 0;
  private pending?: { generation: number; result: Promise<Skill[]> };
  constructor(
    private client: Pick<AppServerClient, "request">,
    private cwd: string,
  ) {}

  invalidate(): void {
    this.generation++;
  }

  private async skills(): Promise<Skill[]> {
    for (;;) {
      const generation = this.generation;
      if (this.pending?.generation !== generation) {
        const result = this.load();
        this.pending = { generation, result };
      }
      const pending = this.pending;
      try {
        const skills = await pending.result;
        if (generation === this.generation) return skills;
      } catch (error) {
        if (this.pending === pending) this.pending = undefined;
        throw error;
      }
    }
  }

  private async load(): Promise<Skill[]> {
    const result = listSchema.parse(
      await this.client.request("skills/list", {
        cwds: [this.cwd],
        forceReload: true,
      }),
    );
    const entry = result.data.find(
      (item) => path.resolve(item.cwd) === path.resolve(this.cwd),
    );
    if (!entry)
      throw new Error(
        "Codex did not return skills for the conversation working directory",
      );
    // Native diagnostics omit invalid skills; only successfully loaded entries
    // can be offered or invoked. Never reconstruct missing entries from disk.
    return entry.skills.filter((skill) => skill.enabled);
  }

  async commands(): Promise<CommandItem[]> {
    return (await this.skills()).map((skill) => ({
      name: `$${skill.name}`,
      description: skill.description,
      type: "skill",
      source:
        skill.pluginId?.split("@")[0] ||
        (skill.scope === "repo" ? "project" : skill.scope),
      skillPath: skill.path,
    }));
  }

  async invocations(text: string): Promise<CodexSkillInput[]> {
    const references = parseSkillReferences(text);
    if (!references.length) return [];
    const skills = await this.skills();
    const selected = new Map<string, CodexSkillInput>();
    for (const reference of references) {
      const skill = skills.find(
        (item) => item.name === reference.name && item.path === reference.path,
      );
      if (!skill)
        throw new Error(
          `Skill $${reference.name} is no longer available in this conversation. Select it again from autocomplete.`,
        );
      selected.set(skill.path, {
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    return [...selected.values()];
  }
}
