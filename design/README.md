# Blackwing UI design (source of truth for every GUI)

This folder holds the Blackwing console design exported from Claude Design
(project *Blackwing Design System*, `0a45ec39-61a0-4269-bd89-cdb387293c89`). **All GUI work follows it.** That
covers `apps/web`, `packages/ui`, the SOC portal, the emergency kill page, the operator console, report HTML
templates and the e-mail templates. Build the screens it shows to match it. Build screens it does not show from
its tokens and components.

| File | What it is |
|---|---|
| [`Blackwing Design System.dc.html`](Blackwing%20Design%20System.dc.html) | Principles, references, colour tokens (light and dark, with contrast ratios), type, grid, spacing, icons, components in both themes, and open questions. |
| [`Blackwing Screens.dc.html`](Blackwing%20Screens.dc.html) | Screens, pass 1: the moments that can't go wrong. They are live prototypes, not static pictures. |
| [`tokens.json`](tokens.json) | The design system's colour tokens (31, light and dark) and fonts, extracted as data. `packages/ui` builds its Tailwind 4 theme from this file. |
| `support.js` | The Claude Design runtime the two `.dc.html` files load. It is generated, so do not edit it. |

## Viewing it

The `.dc.html` files load `./support.js`, React and Google Fonts, so open them through a local web server:

```bash
python3 -m http.server 8099 -d design   # then open http://localhost:8099/Blackwing%20Screens.dc.html
```

Use the theme switch on the page to toggle light and dark.

## Screens in pass 1 and who builds them

| Design | Screen | Route (console) | Built by |
|---|---|---|---|
| 1a Flight deck | Live run: agents as lanes on a scrolling time axis, with the Gate 2 banner, the "Authorised under SA-…" strip, the clock, budget gauges, and Pause / Run manifest / Kill run | `/assessments/:id` | LIVERUN epic #273 (shell from CONSOLE #260) |
| 1b Transcript | Live run as a redacted transcript and event stream | `/assessments/:id` (tab) | LIVERUN #273 |
| 2a Gate 2 | Gate 2 decision on desktop. The countdown is the interface, and no decision means denied. Shows who was paged, the action, intrusiveness, environment, the reversal-journal status, why it falls outside the SA, and the agent's reason (unverified) | `/approvals/gate2/:id` | GATE2 #203 + LIVERUN #273 |
| 2b Gate 2 mobile | The same decision at 390 px, opened from a page, SMS or Slack link | `/approvals/gate2/:id` | GATE2 #203 |
| 3a Kill | Kill dialog: blast radius drawn as nested rings (run, asset, organisation, global), typed confirmation, then measured halt progress (egress blocked, sandboxes ended, keys revoked, workflows cancelled) and the audit event | dialog on every run screen | KILL #170 + LIVERUN #273 |
| 3b Emergency link | The SOC's login-free emergency stop, used by holding the button | `/kill/:token` (public) | KILL #170 / SOCUI #552 |

Screens that pass 1 does not cover yet are dashboard, assets, standing authorisations, the new-assessment form,
the test-plan editor with Gate 1, triage with Gate 3, findings, coverage, reports, admin and operator. Build them
from the design system's tokens and components. Use the layout grammar the pass-1 screens set: top bar,
breadcrumb header, status chips, the authorisation strip and the right-hand context panel.

## Design-system rules that the code must keep

- **Colour roles.** Kill red (`--kill`, `#B01A2D` light) is used **only** for the Kill button, the Killed state and
  the logo. Navy (`--primary`, `#004777` light) is used for actions, links, focus and running states. Ink
  (`#16171D`) is the light-theme text and the dark-theme surface. Every token has a light and a dark value, and
  both must meet WCAG 2.2 AA where the design says they do.
- **Status colours.** `ok` means allowed or passed. `warn` means needs approval. `bad` means blocked or denied.
  Severity uses `crit-bg`, `high`, `med`, `low` and `sinfo`, each with a `-soft` background. Operator mode uses
  the `navy` bar.
- **Type.** Poppins (300–700) for UI text and JetBrains Mono (400, 500) for IDs, hashes, requests and code.
- **Motion.** Pulses, spinners and pings are allowed, and everything stops under `prefers-reduced-motion`.
- **Icons.** Use the line icon set in the design system: lock, ledger, passive, active-safe, state-changing, kill,
  allowed, denied, verified, countdown, approvals, authorisation, secret ref and the rest.
- **The interaction rules in the screens are product rules, not decoration.**
  - A Gate 2 countdown that runs out means denied.
  - Kill needs a scope choice plus a typed confirmation, and it reports the measured halt time.
  - The emergency link needs a hold-to-stop.
  - Agent text is labelled "not verified".
  - Authorisation context (SA ID, signer, key ID) is always visible on a run.

## Implementing from this folder

1. Put the theme in `packages/ui`: CSS variables `--bg … --navy` for light and dark (dark via
   `[data-theme="dark"]` and `prefers-color-scheme`), generated from `tokens.json`, and mapped into the
   Tailwind 4 `@theme` and the shadcn/ui variables. Do not hard-code hex values in components.
2. Rebuild the design-system components as shadcn/ui (Radix) components in `packages/ui`. Keep the same states
   (default, hover, focus, active, disabled, loading, error) in both themes.
3. Rebuild each screen in `apps/web` (Next.js 15, RSC) with real data and the same structure, copy and states.
   The prototype data (Acme Corp, SA-0042, `run_01JABC7Q3M`) is only example data.
4. Ship fonts and logos with the app: self-host Poppins and JetBrains Mono, and put the crow-shield and tinycrows
   logos in `packages/ui`. The prototypes load them from the tinycrows.com CDN and Google Fonts, but the product
   must not depend on third-party hosts at runtime.
5. When code has to depart from the design, for example a §8 invariant or an accessibility fix, the invariant
   wins. Record the departure in the issue and in a short note in this README.

## Open questions from the design (not yet answered)

- A vector (SVG) crow shield is needed for a 16 px favicon. Until one exists, use the PNG at 40 px and above.
- Should operator mode use the blue shield from the website and a navy top bar? The `navy` token already exists
  for that bar.

## Provenance

Exported on 2026-10-20. Two project files are not stored here: `Blackwing Screens.html` (a generated standalone
bundle) and `assets/tinycrows-lockup.png`. The export cut both off at its size limit. The bundle can be
regenerated from the `.dc.html` sources. Re-export both from Claude Design if they are needed. When the design
changes, re-export the `.dc.html` files and `support.js`, regenerate `tokens.json`, and commit them together.
