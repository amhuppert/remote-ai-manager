import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const templateId = {
  name: "id",
  description:
    "Template id: 1-48 lowercase letters, digits, - or _, starting with a letter or digit",
  value: { kind: "string", minLength: 1 },
} as const;
const tier = {
  description:
    "project (this project's library) or global (every project's); found by id when omitted, refusing an id both use",
  value: { kind: "enum", values: ["project", "global"] },
} as const;

export const runTemplateSaveSpec = {
  path: "run template save",
  summary: "Save a run template that Alex can configure and launch",
  description:
    "Create a template, or replace one with --based-on <revision> (the revision run template list or show reports; a template changed since is refused). --tier global saves it for every project, which may name only builtin and global profiles. Without --tier, a replacement goes to the tier holding the template (an id both tiers use is refused), and a create goes to this project unless the global library already uses the id, which is refused. The file is {name, description, parameters, defaults, workflow}. name (at most 120 characters) becomes the run's title. parameters: [{name, description, required}] are free-text values the person launching supplies; write {{inputs.<name>}} (no spaces) in a context's title, brief, task titles and instructions, acceptance criteria, or the charter's text to substitute one. There is no escape: in those fields every {{ must be such a token, and a parameter token anywhere else is refused, since it would stay literal. An omitted optional parameter substitutes empty text, so the save is refused when that would empty a field a launch requires. workflow is a run workflow definition without its title: {contexts, loops, lanes, documents, charter}, with the same topology rules; documents name no revision, and a from file is read when the template is launched. Settings are not written in a context: defaults sets them for every context, and a context's settings overrides any of them, each replacing the template's value whole. The settings are implementer {profile: {tier, id}, backend, modelSelection} (leave backend and model out to use the configured default), reviewers [{authority: blocking|advisory, focus, profile, backend, modelSelection}], checks (registered validation command names, compared with the launching project's when the template is launched), humanApproval, ownerQuestions and timeoutMs (null for none); a setting no tier sets takes Command Center's default, as for run workflow. Problems are reported in stages: the document's shape first, then parameter tokens, then the workflow's topology, then (on save only) profiles that do not resolve; each stage reports all of its problems, and a later stage runs once the earlier ones pass. The check twin runs every stage but the profile check, locally.",
  requires: "cc",
  effects: "write",
  args: [templateId],
  flags: {
    tier: {
      description:
        "project or global; when omitted, see the description for how the tier is chosen",
      value: { kind: "enum", values: ["project", "global"] },
    },
    "based-on": {
      description:
        "Revision the replacement was made from; omit it to create a new template",
      value: { kind: "integer", min: 1 },
    },
  },
  related: [
    {
      path: "run workflow",
      description: "The workflow fields a template's workflow uses",
    },
    { path: "run template show", description: "Read a template to edit it" },
  ],
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "run template save-check",
  },
} as const;
export const runTemplateListSpec = {
  path: "run template list",
  summary: "List this project's run templates and the global ones",
  description:
    "Each template's tier, id, revision, name, context count and parameters, and every template file that cannot be read, with its path to fix or remove. Omitted rows name the exact follow-up read.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    tier: {
      description: "Only this tier's templates",
      value: { kind: "enum", values: ["project", "global"] },
    },
    limit: {
      description: "Maximum templates to return",
      value: { kind: "integer", min: 1 },
      default: 20,
    },
  },
  related: [
    { path: "run template show", description: "Read one template to edit" },
  ],
} as const;
export const runTemplateShowSpec = {
  path: "run template show",
  summary: "Write a run template's content to a file, to edit and save again",
  description:
    "Writes the template's content, the file run template save takes, to a JSON file in the artifact directory, and names the file, the tier and the revision (text: a line and an artifact: line; --json: payload.artifact.path and payload.summary). Copy the file, edit the copy and save it with run template save <id> --tier <tier> --file <copy> --based-on <revision>: a written file is named by its content and never overwritten, so editing it in place would refuse the next read of the same revision. --out <name> names the written file, inside the artifact directory.",
  requires: "cc",
  effects: "read",
  output: "binary",
  args: [templateId],
  flags: { tier },
} as const;
export const runTemplateDeleteSpec = {
  path: "run template delete",
  summary: "Delete a run template",
  description:
    "Deletes the template at the revision you name, refusing one changed since. Runs already launched from it are unaffected.",
  requires: "cc",
  effects: "write",
  args: [templateId],
  flags: {
    tier,
    "based-on": {
      description:
        "The template's current revision, as run template list or show reports it",
      value: { kind: "integer", min: 1 },
      required: true,
    },
  },
} as const;

export const runTemplateLaunchSpec = {
  path: "run template launch",
  summary: "Launch a saved run template in this session",
  description:
    "Launch the template as a workflow run in the session worktree, exactly as run workflow would launch the definition it makes: its settings cascaded per context, each {{inputs.<name>}} replaced by the value you give. The file is {parameters, revision}: parameters maps each parameter name to its text (a required one must not be blank; an omitted optional one becomes empty text; an unknown name is refused), and revision, when given, is the one you read (run template list or show), so a template changed since is refused rather than launched. Documents declared with from are read from the session worktree now. You own the run and follow it from launch: each question, halt and its result wakes you as a subscription update (cctl inbox list --all keeps the delivered ones). The launch-check twin checks only the inputs file and your session identity; the template's lookup, revision, parameter values, profiles, check names (against this project's registered validation commands, a global template's included) and the launch's admission are checked by the launch itself.",
  requires: "cc",
  effects: "write",
  args: [templateId],
  flags: { tier },
  related: [
    { path: "run template list", description: "The templates you can launch" },
    { path: "run show", description: "Follow the launched run" },
  ],
  payload: {
    maxBytes: bytes(262_144),
    validatePath: "run template launch-check",
  },
} as const;

const handlers = async () => import("./template-handlers");

export const runTemplateSaveCommand = ccCommands.defineCommand(
  runTemplateSaveSpec,
  {
    examples: [
      {
        file: ".cc/temp/release-checklist.json",
        args: { id: "release-checklist" },
        why: "Create a template in this project",
      },
      {
        file: ".cc/temp/release-checklist.json",
        args: { id: "release-checklist" },
        flags: { "based-on": 2 },
        why: "Replace revision 2 with an edited copy",
      },
    ],
    handler: async () => ({ default: (await handlers()).saveHandler }),
  },
);
export const runTemplateListCommand = ccCommands.defineCommand(
  runTemplateListSpec,
  {
    examples: [{ why: "See the templates this project can launch" }],
    handler: async () => ({ default: (await handlers()).listHandler }),
  },
);
export const runTemplateShowCommand = ccCommands.defineCommand(
  runTemplateShowSpec,
  {
    examples: [
      {
        why: "Write a template to a file to edit it",
        args: { id: "release-checklist" },
      },
    ],
    handler: async () => ({ default: (await handlers()).showHandler }),
  },
);
export const runTemplateDeleteCommand = ccCommands.defineCommand(
  runTemplateDeleteSpec,
  {
    examples: [
      {
        why: "Delete a template",
        args: { id: "release-checklist" },
        flags: { "based-on": 3 },
      },
    ],
    handler: async () => ({ default: (await handlers()).deleteHandler }),
  },
);

export const runTemplateLaunchCommand = ccCommands.defineCommand(
  runTemplateLaunchSpec,
  {
    examples: [
      {
        file: ".cc/temp/release-inputs.json",
        args: { id: "release-checklist" },
        why: "Launch a template with its parameter values",
      },
    ],
    handler: async () => ({ default: (await handlers()).launchHandler }),
  },
);

export const runTemplateCommands = [
  runTemplateSaveCommand,
  runTemplateListCommand,
  runTemplateShowCommand,
  runTemplateDeleteCommand,
  runTemplateLaunchCommand,
] as const;
export const runTemplateGroups = [
  defineGroup({
    path: "run template",
    summary: "Save and launch run templates that Alex configures",
    description:
      "A run template is a workflow with {{inputs.<name>}} parameters and its settings in two tiers; Alex edits its settings and content in Command Center and launches it, and an agent launches one with run template launch and owns the run.",
  }),
] as const;
