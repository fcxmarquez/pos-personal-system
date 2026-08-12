# CLAUDE.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

POS (Point of Sale) system for a stationery store ("Papelería Luna"). Built with Next.js App Router, TypeScript, and Zustand for state management.

## Important Commands

- **Dev server**: `bun run dev`
- **Build**: `bun run build`
- **Format**: `bun run format`
- **Lint**: `bun run lint`
- **Typecheck**: `bun run typecheck` (app + langgraph agent; `typecheck:app` / `typecheck:agent` run them individually)
- **Test**: `bun test` (or `bun run test`)
- **Install deps**: `bun install --frozen-lockfile`

Tests use Bun's built-in runner (`bun:test`) — no extra framework. Test files live
next to the code they cover as `*.test.ts` (e.g.
`lib/copilotkit/google-aware-langgraph-agent.test.ts`).

## Architecture

### App Structure

Single-page application using Next.js App Router (`app/` directory). The root page renders `AppShell` which manages navigation between three screens:

- **VentasScreen** — Sales/checkout with cart, barcode lookup, and payment processing
- **ProductosScreen** — Product CRUD management (PIN-protected)
- **CorteScreen** — Cash reconciliation/daily audit (PIN-protected)

### State Management

All application state lives in a single Zustand store (`lib/store.ts`) with localStorage persistence (key: `papeleria-pos-storage`). The store manages products, cart, sales history, and reconciliation records.

### UI Layer

Components in `components/ui/` are shadcn/ui primitives (Radix UI + Tailwind CSS). Business logic components live in `components/pos/`. Styling uses Tailwind CSS with HSL CSS custom variables for theming and class-based dark mode.

### Key Conventions

- All interactive components use `"use client"` directive
- Forms use React Hook Form with Zod validation schemas
- Currency formatted as `$X.XX` via inline `toFixed(2)`
- Dates use `date-fns` with `es-MX` (Spanish/Mexico) locale
- Path alias: `@/*` maps to project root
- Admin PIN is configured via `NEXT_PUBLIC_ADMIN_PIN` env variable (defaults to `"1234"`)

#### Query Organization Conventions

- Server-side database query modules live in `lib/server/queries/*` (not under `app/*`).
- `app/actions/*` files are the server action boundary and can call `lib/server/queries/*`.
- Global TanStack Query client/cache definitions live in `lib/query/`. Component-local queries live alongside the component as `query.ts` (e.g. `components/pos/sales-screen/query.ts`).
- Keep UI components focused on rendering and interactions: extract query keys and query functions into the query files.

### Directory & File Naming Conventions

- Each component lives in its own directory named with kebab-case: `component-name/index.tsx`.
  - Example: `components/pos/sales-screen/index.tsx`
- If a component has a TanStack Query used only by that component, place it inside the component directory as `query.ts`.
  - Example: `components/pos/sales-screen/query.ts`
- Shared/global TanStack Query definitions (used by multiple components) live in `lib/query/`.

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint and build on push/PR to `main` using Bun.

### Build Config

`next.config.mjs` has `typescript.ignoreBuildErrors: true` and `images.unoptimized: true`.

### Backend

- Neon PostgreSQL is used as the database.

## Code Workflow

### Git Workflow

- Follows @commitlint/config-conventional standards
- The commit doesn't have to have a body. Has to be brief. Don't mention you as co-author in the commit message.
- Don't push commits.

### Testing and Quality Checks

- After each finished task, run:
  - `bun run format`
  - `bun run lint`
  - `bun run typecheck`
  - `bun test`
  - `bun run build`

- For testing the database. Very important to test over the development database. NEVER test over the production database.

### Automated Testing / Remote Agents

The app supports an alternative login mode for automated testing and CI environments. When this mode is active, the login page shows a username/password form instead of Google OAuth. Use the following credentials to log in:

- **Username**: `root`
- **Password**: `testing`

This mode is enabled via an environment variable in `.env.local`. Check `.env.example` for the variable name and usage instructions.

## UI guidelines

- Always use the design tokens for the colors previously defined in the app/globals.css file.
- Always use the tailwind font sizes, radius and spacing instead of hardcoded values
- Always use only md breakpoint for responsive classes. Avoid using sm breakpoint or any other breakpoint.
- For more information not mentioned here, refer to storybook documentation.

## Cursor Cloud specific instructions

### Environment

- **Runtime**: Bun (installed at `~/.bun/bin/bun`). Ensure `~/.bun/bin` is on `PATH`.
- **Database**: Neon PostgreSQL (cloud-hosted). Requires `DATABASE_URL` secret.
- **Auth**: Set `AUTH_BYPASS=true` in `.env.local` for credential-based login (`root`/`testing`). Requires `AUTH_SECRET` secret.
- `.env.local` must be created from `.env.example` with the secrets above plus `NEXT_PUBLIC_ADMIN_PIN="1234"`.

### Running the app

- `bun run dev` starts the Next.js dev server on port 3000.
- The health endpoint at `/api/health` confirms database connectivity.
- PIN-protected sections (Productos, Corte de Caja) use PIN `1234`.

### Linting & Testing

- Linter is **Biome** (not ESLint). `bun run lint` runs `biome check .`.
- Tests use Bun's built-in runner: `bun test` (`*.test.ts` files). Quality checks are `bun run lint`, `bun run typecheck`, `bun test`, and `bun run build`.
- `bun run typecheck` covers both the Next.js app (`tsc --noEmit`) and the LangGraph agent (`tsc -p langgraph/tsconfig.json`); the agent has its own tsconfig because it runs on Node, not in the browser. `bun run build` does **not** catch type errors (`next.config.mjs` sets `typescript.ignoreBuildErrors: true`), so `typecheck` is the real type gate.
