# Revenue Lens — operator workbench design

Owned: `demo/`, `src/why/`. Brand assets live under `demo/public/brand/` (logo copied unchanged; Jersey20 for brand/headings only).

## Brand

| Element | Spec |
|---|---|
| Product | **Revenue Lens** |
| Subtitle | by Agentel |
| Environment | Agentel Revenue Lab |
| Logo | `/brand/logo.png` (supplied Agentel mark, never redrawn) |
| Display font | Jersey20 (`/brand/Jersey20-Regular.woff2`) — brand + headings only |
| Body | Readable system sans |
| Labels | Mono, uppercase micro-labels |
| Navy | `#080b12` / `#0e131e` (+ panel `#151b2a`) |
| Lavender | `#b19bff` (restrained accents, borders) |
| Off-white | `#f5f2fb` |

## Layout (1280×720 / 1440×900 / 1920×1080)

1. **Topbar** — logo + Revenue Lens + by Agentel; permanent tags: Sandbox / Synthetic data / Injected fault; environment name.
2. **Hero** — full width; title as two balanced phrases (*Paid. Provisioned.* / *Still locked out?*) at ~36px Jersey so it reads cleanly at 1280. Subtitle product language: *Find why a paid customer lost access. Review the evidence. Restore the right workspace.* No fabricated stats.
3. **Stages** — Observe / Explain / Review / Restore; lavender numbers; state from real probe/run/plan/receipt only.
4. **Customer** — concise name + workspace; Access badge Unknown → actual **403** / **200** after probe.
5. **Timeline** — action cards; minimal role labels; raw JSON collapsed.
6. **Why** — observation labeled `observedAt`; expandable citations; hypotheses tagged inference; separate after-repair section.
7. **Repair** — Review & repair copy; CTAs **Confirm repair** / **Retry same repair** open an accessible in-page `<dialog>` (never `window.confirm`). Second click **Confirm this repair** is required before any write; Cancel restores focus. Account/run change clears the dialog.
8. **About this lab** — collapsed: unbound roles, token/intentKey/client-plan notes, H-MEM/Scan unavailable.

Browser acceptance: exercise the dialog under recording/CDP; unit coverage for the confirm view-model is in `demo/confirm-summary.test.ts` (DOM-free).

## Honesty constraints

- Customer access starts **unknown** until Test access or post-repair probe; badge shows the real HTTP status afterward.
- Source/coverage status only from this run’s tool facts — no invented network health.
- Recovery only when receipt is `applied|replayed` **and** probe HTTP 200.
- Proposed Agentel roles (Workflow Atlas / LoopSmith) are **unbound** — disclosed under About this lab, not the hero.
- H-MEM and Scan are **not** offered as buttons until implemented.
- Capture hygiene: keep unrelated IDE/Projects sidebars hidden; record only `http://127.0.0.1:8791`.

## Static routes (explicit allowlist)

`/`, `/index.html`, `/app.js`, `/style.css`, `/brand/logo.png`, `/brand/Jersey20-Regular.woff2`

No private file routes or directory browsing.

## APIs preserved / added

| Method | Path | Notes |
|---|---|---|
| GET | `/api/accounts` | Public cast fields only (no token, no seed role) |
| POST | `/api/probe-access` | Scoped sandbox probe; status/body only |
| POST | `/api/investigate` | Unchanged security (cast lock, origin check) |
| GET | `/api/runs/:id` | `?run=` deep-link |
| POST | `/api/runs/:id/confirm-repair` | `confirm:true` + matching `intentKey` only |

Account change in the UI clears run / receipt / probe and disables repair until a new investigation. In-flight requests use a request-id guard so stale responses cannot paint.
