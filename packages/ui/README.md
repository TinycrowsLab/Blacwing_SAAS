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
- Fonts: `--font-family-sans` (Poppins), `--font-family-mono` (JetBrains Mono). Theme provider and toggle: CONSOLE-003.

## Components

Button, Input, Label, FormField, Select, Dialog, Sheet, DropdownMenu, Tooltip, Tabs, Table, Badge, Card,
Toast, Skeleton, Avatar, Separator, Breadcrumb. Variants use `class-variance-authority`
(`buttonVariants`, `badgeVariants`, `toastVariants`). All forward refs and are typed without `any`.
Interactive primitives are Radix underneath (roles, focus trap, keyboard) and marked `'use client'`;
Button, Input, Badge, Card, Table, Skeleton, Breadcrumb are server-safe.
Icons: `lucide-react` (pinned).

## Bundle budget

Each module is imported by name from the barrel and the package declares `sideEffects: ["**/*.css"]`, so
bundlers drop unused components. Budget: kit JS for a route that uses Button + Dialog + Table stays under
30 kB gzipped; verify with `next build` analysis once the console lands (CONSOLE-001).

## Tests

`pnpm --filter @blackwing/ui test` (Vitest + Testing Library). Visual and axe tests: CONSOLE-011 / CONSOLE-009.
