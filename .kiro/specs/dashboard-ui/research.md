# Research & Design Decisions

## Summary

- **Feature**: `dashboard-ui`
- **Discovery Scope**: Extension (existing system — fully implemented)
- **Key Findings**:
  - Complete three-level navigation hierarchy: Projects → Sessions → Session Detail
  - Dark-themed design system with 5 elevation levels, cyan accent, custom CSS properties
  - Responsive design with mobile (768px), tablet (900px) breakpoints
  - Server Components for data loading, Client Components for interactivity
  - No UI-level tests exist currently

## Research Log

### Existing Architecture Analysis

- **Context**: Dashboard UI is already implemented; mapping implementation against requirements.
- **Sources Consulted**: All page components, shared components, globals.css, layout.tsx, API routes
- **Findings**:
  - **Project List** (`projects/page.tsx`): Server Component discovers projects, renders ProjectCard grid. Cards show name, path, session count, active/idle status.
  - **Sessions List** (`projects/[name]/page.tsx`): Server Component loads sessions, renders SessionsList client component. Includes CreateSessionModal with name validation and branch preview.
  - **Session Detail** (`projects/[name]/[session]/page.tsx`): Server Component loads session, diff, transcript. SessionDetailPage client component orchestrates all panels.
  - **Topbar** (`components/Topbar.tsx`): Shared breadcrumb navigation with page-specific right-side controls (global status vs session controls).
  - **ConfirmDialog** (`components/ConfirmDialog.tsx`): Reusable modal for destructive action confirmation.
  - **Layout** (`app/layout.tsx`): Root layout with font loading (Anybody, Manrope, Geist Mono). No persistent navigation — each page renders its own Topbar.
  - **Home** (`app/page.tsx`): Immediate redirect to `/projects`.
  - **Design System** (`globals.css`): Custom CSS properties for colors, elevation, borders, typography, spacing. Atmospheric effects (noise, scanlines). Stagger-in animations.
  - **Responsive**: Mobile bottom bar for panel switching, collapsible info strip, bottom sheet modals, 44px touch targets, condensed breadcrumbs.
- **Implications**: Feature is complete. No production code gaps. Test coverage is the primary gap.

### Component Architecture Patterns

- **Context**: Understanding the Server/Client component split.
- **Findings**:
  - Pages are async Server Components that fetch data and pass as props
  - Interactive components (SessionsList, SessionDetailPage, DiffPanel, etc.) are Client Components with `"use client"` directive
  - Feature-specific components colocated in page directories
  - Shared components (Topbar, ConfirmDialog) in `src/components/`
  - No context providers or global state — data flows via props from server to client
- **Implications**: Clean unidirectional data flow. Testing can focus on client components in isolation.

### Design System

- **Context**: Understanding the visual language.
- **Findings**:
  - Dark theme only (no light mode)
  - 5 elevation levels: void → base → surface → raised → hover
  - Accent color: cyan with glow effects
  - Status colors: green (active/running), amber (idle), red (danger/deletion)
  - Typography: Anybody (display), Manrope (body), Geist Mono (code/monospace)
  - Atmospheric effects: noise texture overlay, scanline effect on cards
  - Animations: fadeIn, slideUp, spin, pulse-border, staggerReveal
  - No component library — all custom CSS
- **Implications**: Design system is self-contained. No external UI library dependency.

## Design Decisions

### Decision: Server-Side Data Loading

- **Context**: How to fetch data for page rendering.
- **Selected Approach**: Async Server Components with props-based data passing
- **Rationale**: Next.js 15 App Router encourages Server Components for data fetching. This eliminates client-side loading states for initial render and keeps domain logic server-side. Client components receive ready-to-render data.

### Decision: Feature-Colocated Components

- **Context**: Where to place page-specific components.
- **Selected Approach**: Components colocated in their page directory (e.g., `projects/[name]/SessionsList.tsx`)
- **Rationale**: Keeps related code together. Only truly shared components (Topbar, ConfirmDialog) live in `src/components/`. This prevents a monolithic components directory and makes it clear which components belong to which page.

### Decision: CSS Custom Properties Design System

- **Context**: How to implement consistent styling.
- **Selected Approach**: CSS custom properties in `globals.css` with no component library
- **Rationale**: Full control over the visual design. CSS custom properties provide theming without runtime overhead. The atmospheric effects (noise, scanlines) and custom animations would be difficult to achieve with a pre-built component library.

### Decision: No Global State Management

- **Context**: How to manage application state.
- **Selected Approach**: No global state — data flows from server via props, local state in client components
- **Rationale**: The app has minimal cross-component state needs. Layout mode is per-session (localStorage). Session list and detail pages fetch fresh data on navigation. No real-time updates require shared state.

### Project Archive State Persistence (Req 11)

- **Context**: Projects are discovered via filesystem scan. `DiscoveredProject` is a plain interface with no `archived` field. Sessions already have `archived: boolean` in `SessionState`. Where should project-level archive state live?
- **Sources Consulted**: `src/lib/state.ts`, `src/lib/discovery.ts`, `src/lib/schemas.ts`, `src/types/index.ts`
- **Findings**:
  - `ManagerState.projects` is keyed by absolute path, but only contains projects that have had sessions created
  - Projects without sessions have no entry in state — they're ephemeral filesystem scan results
  - `SessionState.archived` already exists and works by excluding from `activeSessions` count
  - State is persisted via atomic JSON writes to `~/.config/csm/state.json`
- **Implications**: Need a top-level `archivedProjects` array in `ManagerState` to store project paths, since project entries may not exist in `projects` map. This avoids creating empty project entries just to hold an archive flag.

### Client-Side Filtering Architecture (Req 9, 10)

- **Context**: Search and status filters operate on the project list. Currently `ProjectsPage` is a Server Component that renders all projects.
- **Findings**:
  - Server Component cannot hold interactive state (search query, active filter)
  - Need a Client Component wrapper between `ProjectsPage` and the cards grid
  - All projects (including archived) must be passed to the client to enable archive toggle without server round-trip
  - `discoverProjects()` currently excludes archived sessions from counts but returns all discovered repos
- **Implications**: Introduce a `ProjectsGridClient` wrapper that receives all projects + archived set as props, manages search/filter state locally, and renders filtered `ProjectCard` components.

### Context Menu Pattern (Req 12)

- **Context**: Project cards need an extensible action menu. Currently `ProjectCard` is a simple `<Link>` wrapper with no interactivity beyond navigation.
- **Findings**:
  - `ProjectCard` is wrapped in `<Link>` — context menu clicks must call `event.preventDefault()` / `event.stopPropagation()` to avoid navigation
  - Existing button patterns: `btn-icon-only` (30x24px) for topbar, `btn-danger btn-sm` for session delete
  - No existing dropdown/popover component in the codebase
  - Menu needs to be positioned relative to the trigger, anchored right to avoid overflow
- **Implications**: New `CardContextMenu` component needed. Must handle: open/close state, click-outside dismissal, Escape key, single-open-at-a-time constraint, and event propagation (parent Link navigation).

## Design Decisions

### Decision: Top-Level archivedProjects Array

- **Context**: Where to persist project archive state
- **Alternatives Considered**:
  1. Add `archived` flag to `ProjectState` in `ManagerState.projects[path]` — requires creating entries for projects without sessions
  2. Add `archivedProjects: string[]` at top level of `ManagerState` — clean, no empty entries
  3. Separate preferences file — overengineered for a single boolean per project
- **Selected Approach**: Option 2 — `archivedProjects` string array at top level of `ManagerState`
- **Rationale**: Simplest approach. Avoids creating empty project entries. Array of absolute paths is unambiguous. Backward compatible (new field, optional).
- **Trade-offs**: Separate from session data structure; paths must be kept consistent with filesystem scan results.

### Decision: Client-Side Filtering with Server Data

- **Context**: How search and status filters apply to the project list
- **Alternatives Considered**:
  1. URL query params with server-side filtering — requires full page re-render per keystroke
  2. Client component wrapper with local state — instant filtering, no server round-trip
  3. API endpoint for filtered results — overengineered for small dataset
- **Selected Approach**: Option 2 — Client component wrapper manages filter state, receives full project list from server
- **Rationale**: Project lists are small (tens, not thousands). Client-side filtering provides instant feedback. Search query and filter selection are ephemeral UI state, not worth persisting to URL/server.
- **Trade-offs**: All projects loaded on initial render regardless of filters. Acceptable for the expected scale.

### Decision: Composable Context Menu Component

- **Context**: How to implement the extensible action menu on project cards
- **Alternatives Considered**:
  1. Inline dropdown in each `ProjectCard` — duplicates logic, not reusable
  2. Separate `CardContextMenu` component accepting `items` prop — reusable, testable
  3. Headless UI library (Radix, etc.) — adds dependency, overengineered
- **Selected Approach**: Option 2 — `CardContextMenu` with typed `items` array prop
- **Rationale**: Keeps `ProjectCard` focused on presentation. Menu items can be composed by the parent. No new dependencies.

## Risks & Mitigations

- **No loading states** — No `loading.tsx` or `error.tsx` files exist. Next.js default handling is used. This is acceptable for a local-first tool but could be improved.
- **Manual refresh** — Session status doesn't auto-update. Users must refresh the page. Acceptable for MVP.
- **No error boundaries** — Component errors could crash the page. Low risk for a developer tool with trusted data.
- **Link + context menu conflict** — `ProjectCard` wraps in `<Link>`. Menu button clicks must stop propagation. Mitigated by `event.stopPropagation()` on the menu trigger and all menu items.
- **Archive data consistency** — If a project directory is renamed/moved, archived path becomes stale. Mitigated by checking archived paths against current discovery results during render.

## References

- Next.js 15 App Router — Server/Client component model
- CSS Custom Properties — for design system tokens
- localStorage — for layout mode persistence
