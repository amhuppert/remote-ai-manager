# AI-DLC and Spec-Driven Development

Kiro-style Spec Driven Development implementation on AI-DLC (AI Development Life Cycle)

## Project Context

### Paths

- Steering: `.kiro/steering/`
- Specs: `.kiro/specs/`

### Steering vs Specification

**Steering** (`.kiro/steering/`) - Guide AI with project-wide rules and context
**Specs** (`.kiro/specs/`) - Formalize development process for individual features

### Active Specifications

- Check `.kiro/specs/` for active specifications
- Use `/kiro:spec-status [feature-name]` to check progress

## Development Guidelines

- Think in English, generate responses in English. All Markdown content written to project files (e.g., requirements.md, design.md, tasks.md, research.md, validation reports) MUST be written in the target language configured for this specification (see spec.json.language).

## Minimal Workflow

- Phase 0 (optional): `/kiro:steering`, `/kiro:steering-custom`
- Phase 1 (Specification):
  - `/kiro:spec-init "description"`
  - `/kiro:spec-requirements {feature}`
  - `/kiro:validate-gap {feature}` (optional: for existing codebase)
  - `/kiro:spec-design {feature} [-y]`
  - `/kiro:validate-design {feature}` (optional: design review)
  - `/kiro:spec-tasks {feature} [-y]`
- Phase 2 (Implementation): `/kiro:spec-impl {feature} [tasks]`
  - `/kiro:validate-impl {feature}` (optional: after implementation)
- Progress check: `/kiro:spec-status {feature}` (use anytime)

## Development Rules

- 3-phase approval workflow: Requirements → Design → Tasks → Implementation
- Human review required each phase; use `-y` only for intentional fast-track
- Keep steering current and verify alignment with `/kiro:spec-status`
- Follow the user's instructions precisely, and within that scope act autonomously: gather the necessary context and complete the requested work end-to-end in this run, asking questions only when essential information is missing or the instructions are critically ambiguous.

## Steering Configuration

Project steering files are loaded automatically below. Custom files are supported (managed via `/kiro:steering-custom`).

@.kiro/steering/product.md
@.kiro/steering/tech.md
@.kiro/steering/structure.md

## Next.js MCP Tools

This project uses Next.js 16 with two MCP servers configured in `.mcp.json`:
- **next-devtools**: Application-layer diagnostics (errors, routes, server actions, logs) via the `/_next/mcp` endpoint
- **chrome-devtools**: Browser-layer control (screenshots, console, network, automation) via Chrome DevTools Protocol

Use MCP tools when: diagnosing build/runtime errors, verifying UI after changes, inspecting network requests, debugging client-side issues, or profiling performance. The dev server (`bun run dev`) must be running. See the `nextjs-mcp` skill for detailed tool reference and workflows.

## UI Design Rules

- Use Storybook for UI prototyping. Implement the component and create a `*.stories.tsx` story so the user can review it interactively before approving.
- UI design must follow the design system in `.kiro/specs/ui-design-system/design.md`.
- Run Storybook with `bun run storybook` (port 6006). Stories use `@storybook/nextjs-vite`.
