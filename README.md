# Revenue Lens · by Agentel

A paid customer cannot use their service, although provisioning reports success. Revenue Lens investigates billing, workspace mappings and entitlement history through Zetaris, explains its findings with source references, and proposes a controlled repair when supported.

This is a local synthetic hackathon prototype for Track 02, “The Agent That Can Explain Why”. Synthetic customers and injected faults are labelled. It is not a production service or evidence of real customer adoption.

For the separate three-source Zetaris semantic-layer and data-quality experiment, see [USL evidence and reproduction](docs/ZETARIS-USL.md). The existing Investigator does not query that USL.

## Scope and product boundaries

This repository publishes the Revenue Lens hackathon prototype, including its synthetic sandbox, investigation workflow, and bounded repair example. Those files and their Git history are public. The repository does not contain the Agentel network's production identity, mission/review, trust, matching, payment, or infrastructure implementations. Real customer data, private mission materials, credentials, and runtime memory are outside the example. Agentel Lens for agent-task investigation is a possible future direction, not a shipped capability in this repository.

## What works

- Read-only investigation: a real configured model chooses allowlisted tools; an independent model role checks the proposed explanation against gathered records. These are model workflow roles, not authenticated Agentel network identities.
- Why card: source conditions, citations, model inference, missing evidence and proposed change are kept distinct. Typed hypotheses are checked against scoped source conditions; arbitrary prose is not formally verified.
- Controlled recovery: explicit operator confirmation, current-source reread, version checks and one transaction update an existing entitlement. The sandbox service is queried again to establish an actual HTTP403→200 outcome. Same-intent retry returns the original receipt.
- Bounded tenant scan: permitted synthetic cast only, at most50 distinct payment lines, concurrency2,180-second wall-clock budget; incomplete/capped/timed-out scans are partial. No batch repairs.
- Meterless H-MEM persists diagnostic hints and recalls within one tenant. It can suggest investigation priority; it never changes facts or permissions. Uses the deterministic reference embedding, not NVIDIA embeddings. Unaudited legacy lessons remain on disk but are excluded from recall.

## Requirements and setup

Node.js with TypeScript execution via `tsx`, Docker/Compose, and an accessible configured Zetaris deployment are required. A NVIDIA (or compatible) model API key is required for the investigation workflow. Without a key the investigation reports unavailable; it does not substitute a canned explanation.

This repository does not install or license Zetaris. Provision it through the vendor-supported process and confirm its API credentials and datasource connectivity. Existing local development uses an external Docker network named `zetaris_default`; inspect `infra/docker-compose.yml` before adapting deployment.

```bash
npm install
npm run setup
cp .env.example .env
cp infra/.env.example infra/.env
```

Set the model key privately in `.env`, and configure Zetaris access. Never commit either environment file. `npm run setup` vendors the pinned Meterless H-MEM reference because `vendor/` is not committed. Review its source/license separately from this project's license.

For a new disposable sandbox:

```bash
npm run infra:up
npm run seed
npm run zetaris:register
npm run sandbox
```

**Seeding is a data mutation/reset operation.** Do not reseed an existing recording or review instance without explicitly choosing to replace its synthetic state. `seed/out/demo.json` fixes the observation time and server-side test sessions. Processing-window demonstrations depend on that observation time; do not interpret old sandbox timestamps as current production data.

In another terminal:

```bash
node --import tsx demo/server.ts
```

Open `http://127.0.0.1:8791`. Select an account, test access, investigate and inspect the Why card. If a repair plan exists, review it and use the separate confirmation dialog. Normal, incomplete or conflicting cases must not be forced into a repair. Run records are in-process; restarting the demo loses their IDs unless an operator explicitly reloads an archived run for labelled review.

The demo binds localhost and uses a fixed synthetic cast. It does not provide production operator authentication/RBAC. Do not expose its port publicly or attach real billing/entitlement data as-is. Session tokens stay server-side; `.revenue-lens-memory/` is runtime data, not a submission asset.

## Validation

```bash
node --import tsx --test src/agents/*.test.ts src/why/*.test.ts src/memory/*.test.ts demo/*.test.ts
node --import tsx --test test/*.test.ts
```

The owned investigator/Why/memory/demo suite passed 114 tests on2026-10-25. This includes injected HTTP/model tests, not 114 real model investigations. Real model behavior can fail schema or consistency checks and is not guaranteed by this test count.

The following require a running sandbox and Zetaris:

```bash
npm run check:access -- --all
npm run check:facts
```

`npm run verify:recovery` is a separate recovery acceptance workflow: inspect it before use; it mutates/resets disposable fixtures. Do not run it during recording or independent evidence review.

## Integration and attribution

| Component | Actual role |
|---|---|
| Zetaris | Registers three separate Postgres sources; fixed readonly queries retrieve billing, mappings and entitlement trails, including cross-source joins. |
| Meterless H-MEM | Pinned reference engine stores/recalls local diagnostic hints. Deterministic reference embedding is disclosed. |
| NVIDIA Nemotron | Actual model investigation and Checker calls through configured NVIDIA hosted API; model response IDs retained when available. |
| Cursor | Used for implementation and development records. Later bounded consistency changes were implemented by Codex local tools after Cursor provider connection failure; do not attribute all edits exclusively to Cursor. |
| Agentel | Branding and proposed identity/evidence collaboration context. Formal identity binding, Mission collaboration and Verified Work are not established by this prototype. |

The project began from the Meterless `agentathon-starter` research notebook. Retained `notebook.ts` is the starter example, not the Revenue Lens entrypoint. Existing platform/starter dependencies, pre-window preparation and in-window contributions require an accurate final submission disclosure; this README does not settle competition eligibility or sponsor award criteria.

## Current limits

Explanation consistency enforcement fails closed on detected contradictions or missing required assessments. A real model may still omit fields or write incorrect free-text timing; manually review new investigations before filming. Changing prompts/guards does not retrospectively validate older footage. New audited H-MEM lessons and a fresh paired run are needed before presenting the updated memory behavior as a live result.

Only retargeting an existing sandbox entitlement is implemented. New entitlement creation, arbitrary repair scripts, real customer connectors, Agent task/token recovery and production deployment are outside this version. Agentel Lens for Agent task investigation/recovery is a future direction, not implemented functionality.
