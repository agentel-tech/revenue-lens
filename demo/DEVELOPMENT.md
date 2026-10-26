# Revenue Lens demo (Track 02 handoff slice)

Owned paths: `src/agents/`, `src/why/`, `src/memory/`, `demo/`.

## Prerequisites (already provided by data-layer owner)

- Infra + seed + sandbox product service (ports on `127.0.0.1`)
- Optional: `LLM_API_KEY` in `.env` for a real model run (otherwise investigate returns `unavailable`)

Do **not** reseed, reset databases, or run `verify:recovery` from this slice.

## Run the operator UI

```bash
# terminal A — sandbox product service (if not already up)
node --import tsx services/sandbox/server.ts

# terminal B — demo UI
node --import tsx demo/server.ts
```

Open `http://127.0.0.1:8791` only (Revenue Lens operator UI — use this view for demo captures; hide unrelated Projects sidebars). See `DESIGN.md` and `SHOTLIST.md`.

If the `tsx` CLI fails under IPC restrictions, keep using `node --import tsx` as above.

Demo bounds: request bodies ≤ 32KB, in-memory run store ≤ 100 entries (FIFO), sandbox probe timeout 10s.

Brand assets (required): `demo/public/brand/logo.png`, `demo/public/brand/Jersey20-Regular.woff2` — served only via explicit static paths.

## Operator flow

1. Choose a permitted seeded account (cohort rows omitted; UI shows name + IDs only — no seed role labels).
2. Optional **Test access** — scoped server-side sandbox probe; status/body only; access remains unknown until probed.
3. **Investigate** — bounded investigator → checker against allowlisted tools. `observedAt` frozen from seed. Deep-link with `?run=<id>`.
4. Inspect **timeline** + **Why card** (observation labeled observedAt; after-repair section separate; Markdown export collapsed).
5. If a repair plan was persisted, **Confirm repair** (or **Retry same repair**) opens an **in-page** dialog (not `window.confirm` — native dialogs freeze embedded CDP). Shows account, entitlement/version, old→new workspace, intentKey. Write only after **Confirm this repair**; Cancel restores focus. Server still requires `{ confirm: true, intentKey }` on the persisted plan.
6. Why card reports **customer recovered** only after receipt `applied|replayed` **and** probe HTTP 200.
7. Changing account clears prior run / receipt / probe and disables repair until a new investigation.

## Tests (owned directories only)

```bash
node --import tsx --test src/agents/*.test.ts src/why/*.test.ts src/memory/*.test.ts demo/*.test.ts
```

## Pending (next slice)

- Bounded multi-account **scan** (not implemented; no fake cohort counts).
- Agentel authentication / Mission acceptance for Workflow Atlas and LoopSmith (roles remain proposed/unbound).
- Provider response IDs when `chat()` gains them (today always `providerResponseId: null` + local `callId`).
- Richer H-MEM mining beyond explicit run lessons (current adapter stores lessons with source run + applicability only).

## Honest limitations

- Without `LLM_API_KEY`, investigate is `unavailable` — not a paraphrased diagnosis.
- Model causal links are **inference only**; passed `check_conditions` rows render as separate source-backed checks.
- No automatic or batch repair.
- Cross-origin POSTs are rejected.
