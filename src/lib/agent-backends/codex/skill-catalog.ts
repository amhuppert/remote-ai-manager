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
const selectorSchema = z
  .object({
    enabled: z.boolean(),
    name: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();
export type CodexNativeSkillSelector = z.infer<typeof selectorSchema>;
const effectiveConfigSchema = z.object({
  config: z.object({
    skills: z.object({ config: z.array(selectorSchema).nullish() }).nullish(),
  }),
});

export type CodexNativeSkill = z.infer<typeof skillSchema>;

/** A process-local catalog: invalidation cannot make an older request current. */
export class CodexSkillCatalog {
  private generation = 0;
  private pending?: { generation: number; result: Promise<CodexNativeSkill[]> };
  constructor(
    private client: Pick<AppServerClient, "request">,
    private cwd: string,
  ) {}

  invalidate(): void {
    this.generation++;
  }

  private async skills(): Promise<CodexNativeSkill[]> {
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

  private async load(): Promise<CodexNativeSkill[]> {
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
    const selectors = await this.selectors();
    return entry.skills.map((skill) => {
      const selector = selectors.findLast((entry) =>
        entry.path
          ? path.resolve(entry.path) === path.resolve(skill.path)
          : entry.name === skill.name,
      );
      return selector ? { ...skill, enabled: selector.enabled } : skill;
    });
  }

  async selectors(): Promise<CodexNativeSkillSelector[]> {
    const result = effectiveConfigSchema.parse(
      await this.client.request("config/read", {
        cwd: this.cwd,
        includeLayers: false,
      }),
    );
    return result.config.skills?.config ?? [];
  }

  async inventory(): Promise<CodexNativeSkill[]> {
    return this.skills();
  }

  async commands(): Promise<CommandItem[]> {
    return (await this.skills())
      .filter((skill) => skill.enabled)
      .map((skill) => ({
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
    const skills = (await this.skills()).filter((skill) => skill.enabled);
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
