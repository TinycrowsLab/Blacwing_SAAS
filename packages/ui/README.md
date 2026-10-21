# @blackwing/ui

Shared design-system kit: shadcn/ui-style primitives on Radix, Tailwind CSS 4 tokens, `cn()`.
Every GUI follows [`design/`](../../design/README.md); never hard-code hex values.

## Use

```css
/* apps/web global stylesheet */
@import '@blackwing/ui/styles.css';
@source '../../../packages/ui/src';
```

```ts
import { Button, Dialog, Table } from '@blackwing/ui';
```

`src/tailwind-preset.ts` exports `tailwindPreset`, the single place that names the CSS entry points.
Tailwind is pinned to 4.x: tokens live in CSS, there is no `tailwind.config` theme. Do not add one.

## Token contract

- `src/styles/tokens.css` is the only place theme values are defined: `:root` (light) and `.dark`.
  Colours mirror `design/tokens.json` (asserted by `kit.test.tsx`); re-export from the design file rather than
  hand-editing values.
- `src/styles/theme.css` maps them into Tailwind with `@theme inline`, so `bg-background`,
  `text-foreground`, `border-border`, `bg-primary`, `text-muted-foreground`, severity (`bg-sev-high-soft`)
  and status (`text-success`, `text-warning`, `text-danger`, `bg-kill`) utilities resolve.
- `--radius` is defined once; `rounded-sm/md/lg/xl` derive from it, so changing it restyles every component.
- Fonts: `--font-family-sans` (Poppins), `--font-family-mono` (JetBrains Mono). 

## Components

Button, Input, Label, FormField, Select, Dialog, Sheet, DropdownMenu, Tooltip, Tabs, Table, Badge, Card,
Toast, Skeleton, Avatar, Separator, Breadcrumb, HelpPopover, FirstRunChecklist. Variants use `class-variance-authority`
(`buttonVariants`, `badgeVariants`, `toastVariants`). All forward refs and are typed without `any`.
Interactive primitives are Radix underneath (roles, focus trap, keyboard) and marked `'use client'`;
Button, Input, Badge, Card, Table, Skeleton, Breadcrumb are server-safe.
Icons: `lucide-react` (pinned).

## State components (CONSOLE-006)

`LoadingState` (spinner, table, card, detail skeletons; stops animating under `prefers-reduced-motion`),
`EmptyState`, `ErrorState`, `PermissionDenied`, `NotFound` and `QueryState` (picks exactly one of them for a
query). `ErrorState` takes a structural `ApiErrorLike` (`status`, `code`, `traceId`, `detail`), renders fixed
copy per error kind plus the `code` and a copyable `traceId`, never `message` or stacks, truncates and
sanitises `detail`, and backs Retry off (1s, 2s, 4s, capped at 30s) while disabling it during a refetch. A 403
always renders `PermissionDenied`, a reflection of the server decision, never a client guess. The error
boundaries live in `apps/web` (`components/errors/route-error-boundary.tsx`, `app/(console)/error.tsx`).

## Help and first-run components (CONSOLE help, #819)

`HelpPopover` is an icon button that opens a short explanation of one concept (`HELP_TOPICS`: intrusiveness,
approval gates, separation of duties, confirmed vs suspected, coverage, baseline states, budgets) with a deep link
to the versioned guide. `resolveDocsLink` builds that link and returns `null` for anything but an `https` origin or
a same-origin path, so the summary still shows when the link cannot be built. `FirstRunChecklist` renders ordered
steps with their completion; the caller derives `done` from tenant data and decides visibility. Copy stays free of
customer data and secrets (`help-topics.test.ts`). Empty-state copy and role-aware CTAs live in `apps/web`
(`src/lib/empty-states.ts`) because they depend on the RBAC matrix.

## Bundle budget

Each module is imported by name from the barrel and the package declares `sideEffects: ["**/*.css"]`, so
bundlers drop unused components. Budget: kit JS for a route that uses Button + Dialog + Table stays under
30 kB gzipped; verify with `next build` analysis once the console lands (CONSOLE-001).

## Do and don't

- **Do** use the token utilities (`bg-background`, `text-muted-foreground`, `border-border`, `bg-sev-high-soft`)
  and the `Button`/`Badge`/... variants. Pick a variant before reaching for a class.
- **Do** put `class="dark"` on an ancestor to switch a subtree to the dark token set. Setting only a background
  colour does not restyle token-driven components.
- **Do** wrap a story (or app) in the providers a component needs: `TooltipProvider` for `Tooltip`,
  `ToastProvider` + `ToastViewport` for `Toast`.
- **Don't** hard-code hex, `rgb()` or Tailwind palette colours (`bg-red-500`). Add a token to `src/styles/tokens.css`
  (mirrored from `design/tokens.json`) and map it in `src/styles/theme.css` instead.
- **Don't** add a `tailwind.config` theme or a second theme provider. Tailwind 4 reads tokens from CSS.
- **Don't** join class strings by hand. Merge caller classes with `cn()` so a later Tailwind class overrides an earlier one.

## Storybook

```bash
pnpm --filter @blackwing/ui storybook        # dev server on http://localhost:6006
pnpm --filter @blackwing/ui build-storybook  # static build into storybook-static/ (CI builds it too)
```

- Stories live beside each primitive as `src/components/<name>.stories.tsx` (Component Story Format, title
  `Primitives/<Name>`). Every primitive has one; `storybook.test.tsx` fails if one is missing.
- The toolbar **Theme** switch (Light/Dark) sets `.dark` on the story root. It is a standalone class toggle, not
  the app's theme provider (CONSOLE-003), so the stories show the same token overrides the app gets.
- The `@storybook/addon-a11y` panel reports contrast. Interaction tests are `play` functions (Dialog,
  DropdownMenu, Sheet, Tooltip, Tabs).
- Config is in `.storybook/` with its own `tsconfig.json`, so `src/` keeps its `rootDir`.

## Tests

`pnpm --filter @blackwing/ui test` (Vitest + Testing Library). `storybook.test.tsx` renders every story in light and
dark, runs its `play` interaction and fails on any serious or critical axe violation. Contrast is left to the
Storybook a11y addon, because jsdom has no layout.

## Theming (CONSOLE-003)

`ThemeProvider` (next-themes 0.4.6, pinned) uses the class strategy: `.dark` on `<html>`, default `system`,
choice stored client-side only under `localStorage` key `bw-theme` (no server state, no PII). The pre-hydration
script is injected by next-themes, so there is no flash; do not read `localStorage` in a client effect. If
storage is blocked or full it falls back to `system` without throwing. Mount it once in
`apps/web/src/app/providers.tsx` and put `suppressHydrationWarning` on `<html>` (not `<body>`).
`ModeToggle` is the Light/Dark/System dropdown for the topbar. Tokens exist for `:root` and `.dark`; components
use token utilities only, so they restyle without per-component overrides.

Forced-colors (Windows high contrast): tokens are plain colours that the UA overrides; `styles/index.css` keeps a
`Highlight` focus outline under `@media (forced-colors: active)`. Never encode state by colour alone. Reduced
motion: there is no theme transition, and `prefers-reduced-motion: reduce` zeroes transition/animation durations.
