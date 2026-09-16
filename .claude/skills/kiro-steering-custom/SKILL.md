---
name: kiro-steering-custom
description: Create domain-specific steering when the user requests persistent guidance beyond the core product, technology, and structure documents.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
metadata:
  shared-rules: "steering-principles.md"
---

# Create custom steering

Capture durable conventions for one requested domain under `.kiro/steering/<name>.md`. Read [steering principles](rules/steering-principles.md), existing steering for overlap, and the code/configuration that owns the domain.

Infer the topic and requirements from the user's request. Ask only if missing information materially changes what should be documented. A matching template in `.kiro/settings/templates/steering-custom/` is optional: its examples are research prompts, not policies to import into this project.

Write the verified patterns, non-obvious constraints, and rationale agents need for that domain. Reference current source files for operational detail instead of copying command lists, dependency catalogs, or generic security/architecture checklists. Keep the file as short as the domain permits; there is no minimum length.

Preserve valid user decisions, correct supported stale claims, and avoid duplicating core steering. Add an on-demand pointer in the root instructions naming the domain and when to read it, following the repository's existing loading convention. Custom steering is not automatically loaded by directory membership.

Finish when the domain guidance is grounded in the repository, links resolve, and the new file is discoverable under the right task conditions. Report its path, source evidence, and any consequential unresolved policy choice.
