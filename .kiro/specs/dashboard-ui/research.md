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

## Risks & Mitigations

- **No loading states** — No `loading.tsx` or `error.tsx` files exist. Next.js default handling is used. This is acceptable for a local-first tool but could be improved.
- **Manual refresh** — Session status doesn't auto-update. Users must refresh the page. Acceptable for MVP.
- **No error boundaries** — Component errors could crash the page. Low risk for a developer tool with trusted data.

## References

- Next.js 15 App Router — Server/Client component model
- CSS Custom Properties — for design system tokens
- localStorage — for layout mode persistence
