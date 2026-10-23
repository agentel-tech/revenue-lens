# Revenue Lens

Track 02, The Agent That Can Explain Why. A customer paid, every system says success, and they still cannot use the service. Revenue Lens investigates across billing, workspace mapping and entitlements, explains why, and verifies the repair.

## Sandbox sources (synthetic data, injected faults)

Three independently stored Postgres sources, registered in Zetaris as three datasources, plus a sandbox product service that returns a real 200 or 403.

```bash
cp infra/.env.example infra/.env && cp .env.example .env   # local-only values
npm run infra:up                 # rl-billing, rl-workspace-map, rl-entitlements on zetaris_default
npm run seed                     # deterministic; --seed <name> for a held-out variant
npm run sandbox                  # http://127.0.0.1:8790
npm run check:access -- --all    # every cast member: real HTTP status vs expected
npm run zetaris:register         # register the three sources, run a cross-source join
```

| Source | Tables |
|---|---|
| billing | products, product_features, billing_accounts, payment_lines |
| workspace_map | workspace_mappings (validity intervals, versions), migration_events |
| entitlements | entitlements, grant_events (append-only, keeps mapping version used), provisioning_runs, repair_receipts, sandbox_sessions |

Every key carries `tenant_id`. Zetaris reads through a read-only role and cannot see session tokens. The "still processing" threshold lives in `src/rules.ts`. All data is synthetic; `stale_mapping` rows are injected faults and are labelled in `seed/out/<seed>.json`.

---

The rest of this README is the Meterless agentathon starter this project began from.

# Agentathon Starter: The Research Notebook Agent

A CLI agent whose memory is real H-MEM: it mines what you tell it, ranks what it recalls, explains where every answer came from, and remembers across runs. Zero API keys. Your hackathon project starts by replacing the CLI with your own surface and keeping the memory spine.

<img src="images/notebook-loop.svg" alt="Animated: notebook commands run in a terminal while each one maps to a named H-MEM service: remember to MemoryMiningService, ask to MemoryRetrievalService, audit to TrustLedgerService, sleep to SleepCycleService" width="820" />

## Two minutes to first recall

```bash
npx degit meterless/meterless/templates/agentathon-starter my-agent
cd my-agent
npm install
npm run setup        # REQUIRED: vendors the H-MEM reference into vendor/ (gitignored)

npx tsx notebook.ts seed
npx tsx notebook.ts ask "what did we decide about storage"
```

Step 4 is not skippable: `vendor/` is gitignored, so a fresh clone has no engine until setup runs. The startup line always names which engine source loaded.

Quit the terminal, come back tomorrow, ask again: it still remembers. That persistence (`.notebook/`, also gitignored) is the demo.

## Commands

```bash
npx tsx notebook.ts remember "We always deploy on green CI"
npx tsx notebook.ts ask "when do we deploy"
npx tsx notebook.ts audit mem-1        # the memory's append-only ledger history
npx tsx notebook.ts sleep --preview    # consolidation plan, nothing applied
```

## Where the engine is used (judges look here)

The rubric weights "Meterless engine usage" at 25%. Every command routes through a named H-MEM service; nothing is faked:

| Command | Engine service | Spec section |
|---|---|---|
| `remember` | MemoryMiningService (model-free path) + MemoryStoreService | AGENTS.md 4, 3 |
| `ask` | MemoryRetrievalService (hybrid formula, reinjection, trace) | AGENTS.md 6 |
| `audit` | TrustLedgerService (append-only history) | AGENTS.md 9 |
| `sleep` | SleepCycleService (preview-first, guardrails, backup) | AGENTS.md 8 |
| answer quality over time | feedback deltas are one call away: `hmem.feedback(id, "helpful")` | AGENTS.md 9.2 |

## Add a real model (optional)

The default answer mode is retrieval-only and fully offline. For model mode, copy `.env.example` to `.env` and set `LLM_API_KEY`. The client in `src/llm-client.ts` speaks the OpenAI chat-completions API, so the provider is configuration only:

- NVIDIA hosted Nemotron (default): `LLM_BASE_URL=https://integrate.api.nvidia.com/v1`, `LLM_MODEL=nvidia/nemotron-3-super-120b-a12b`
- Meterless Runtime: `LLM_BASE_URL=http://127.0.0.1:8088/v1`, `LLM_MODEL=meterless/auto`, token from `<stateDir>/proxy-token`

The reinjected memory block goes into the prompt; the answer cites memory ids. Both modes are labeled in the output. Run `npm test` for the client's unit tests.

## Extension ideas by track

- **Memory agents**: extend mining with your own event types; wire `feedback` to thumbs up/down; build the dream review UI.
- **Desktop agents**: pair the notebook with Relay-style execution; memories become preconditions for actions.
- **Creative swarms**: when the swarm orchestration engine drops, fan out variants and remember which ones the user kept.
- **Enterprise workflow**: point `remember` at your CRM export; `ask` becomes account context on demand.

Rubric and tracks: [docs/community/hackathon-guide.md](../../docs/community/hackathon-guide.md). Engine spec: [engines/hmem/AGENTS.md](../../engines/hmem/AGENTS.md).
