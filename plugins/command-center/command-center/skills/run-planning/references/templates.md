# Run templates

Reference for [run-planning](../SKILL.md). Read it when saving a run for the user to configure and launch again, or when launching a saved one.

A **run template** is a saved workflow with free-text parameters. The user configures its settings in Command Center's run template editor, and launches it there. You author its structure and text through `cctl run template`, and you can launch one; you then own the run as if you had launched it with `cctl run workflow`.

## The template file

`{name, description, parameters, defaults, workflow}`:

- `name` (at most 120 characters) becomes the run's title; `description` says what the template is for.
- `parameters: [{name, description, required}]` are the values the person launching supplies. Names use letters, digits, `-` or `_`.
- `workflow` is a `run workflow` definition without its `title`: `{contexts, loops, lanes, documents, charter}`, with the same topology rules. Documents name no revision, and a `from` file is read from the session worktree when the template is launched.
- `defaults` and each context's `settings` hold the settings: `implementer` (`{profile, backend?, modelSelection?}`), `reviewers` (each `{authority, profile, focus?, backend?, modelSelection?}`, a profile being `{tier, id}`), `checks`, `humanApproval`, `ownerQuestions` and `timeoutMs` (`null` for none). A context's setting replaces the template's whole; a setting neither sets takes Command Center's default. Settings are refused inside a context's own fields.

Write `"defaults": {}` and leave settings out unless the user asked for specific ones: they set reviewers, checks, approval and seats in the editor.

`{{inputs.<name>}}` (no spaces) substitutes a parameter in a context's title, brief, task titles and instructions, and acceptance criteria, and in the charter's text. In those fields every `{{` must start such a token; there is no escape, and a token anywhere else is refused. An omitted optional parameter becomes empty text, so write the surrounding sentence to survive that; a save that would leave a required field empty is refused.

```json
{
  "name": "Fix a reported bug",
  "description": "Reproduce a bug with a failing test, fix it, and have the fix reviewed.",
  "parameters": [
    { "name": "bug", "description": "What goes wrong, and how to see it", "required": true },
    { "name": "start", "description": "Where to start looking, as a whole sentence (optional)", "required": false }
  ],
  "defaults": {},
  "workflow": {
    "contexts": [
      {
        "key": "reproduce",
        "brief": "Write a test that fails because of this bug: {{inputs.bug}}. Change no production code. {{inputs.start}}",
        "outputSchema": {
          "type": "object",
          "properties": { "test": { "type": "string" }, "failure": { "type": "string" } },
          "required": ["test", "failure"]
        }
      },
      {
        "key": "fix",
        "brief": "Fix the bug so the reproducing test passes: {{inputs.bug}}",
        "dependsOn": ["reproduce"],
        "acceptanceCriteria": ["The reproducing test passes, and no other test changed to make it pass"]
      }
    ]
  }
}
```

## Saving and editing

```
cctl run template save-check fix-bug --file .cc/temp/fix-bug.json
cctl run template save fix-bug --file .cc/temp/fix-bug.json
cctl run template list
cctl run template show fix-bug
cctl run template save fix-bug --file .cc/temp/fix-bug.json --based-on 2
cctl run template delete fix-bug --based-on 3
```

- The id is 1–48 lowercase letters, digits, `-` or `_`, starting with a letter or digit. A template is saved in this project's library, or with `--tier global` in every project's; a global template may name only builtin and global profiles. Without `--tier`, a replacement goes to the tier that holds the id, and a create goes to this project, refused when the global library already uses the id.
- The template file is at most 1 MB, and a launch's inputs file at most 256 KB.
- Problems are reported in stages: the file's shape, then parameter tokens, then the workflow's topology, then, on save only, profiles that do not resolve. The check verb runs every stage but the profile check.
- To edit, write the template to a file with `show`: the reply names its tier and revision, and its `artifact:` line names the file, the one `save` takes. Copy it to `.cc/temp/<id>.json`, edit the copy and save that with `--based-on <revision>`; the written file is never overwritten, so an edited one would block reading the same revision again. A template changed since is refused: read it again. The user may have changed its settings in the editor, so start from the current file, never from your old copy.
- Deleting a template leaves runs launched from it untouched.

## Launching

`cctl run template launch <id> --file <inputs>` launches the template in this session as `cctl run workflow` would launch the definition it makes. The inputs file is `{parameters, revision}`:

```json
{
  "parameters": { "bug": "Saving a draft twice creates two drafts", "start": "Start in src/drafts." },
  "revision": 1
}
```

- `parameters` maps each parameter's name to its text. A required one must not be blank, and an unknown name is refused.
- `revision` is the one `list` or `show` reports; a template changed since is refused rather than launched. Name it whenever you reviewed the template before launching.
- `cctl run template launch-check` checks only the inputs file and your session identity. The launch itself resolves the template, its revision, the parameters, the profiles, the check names against this project's registered commands, and the launch's admission.
