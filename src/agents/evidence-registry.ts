// Run-local opaque evidence IDs (e1, e2, …). Issued only when scoped tool facts
// arrive. Maps ID → exact original SourceRef. Models cite IDs; runtime resolves.

import type { SourceRef } from "../contracts.ts";

export type EvidenceId = string;

/** Canonical key string: sorted entries, exact equality basis for SourceRef.key. */
export function sortedKeyEntries(key: Record<string, string>): string {
  return Object.keys(key)
    .sort()
    .map((k) => `${k}=${key[k]}`)
    .join("&");
}

export interface EvidenceEntry {
  id: EvidenceId;
  ref: SourceRef;
  /** Fact fields shown to the model (no nested SourceRef). */
  fact: Record<string, unknown>;
}

/** Authoritative domain record kinds — never demoted by condition_ref annotations. */
const AUTHORITATIVE_KINDS = new Set([
  "payment",
  "mapping",
  "migration",
  "entitlement",
  "grant",
  "provisioning_run",
]);

function isConditionRefFact(fact: Record<string, unknown>): boolean {
  return fact.kind === "condition_ref";
}

function isAuthoritativeFact(fact: Record<string, unknown>): boolean {
  return typeof fact.kind === "string" && AUTHORITATIVE_KINDS.has(fact.kind);
}

function conditionAnnotationFrom(fact: Record<string, unknown>): Record<string, unknown> {
  const { kind: _k, conditionAnnotations: _a, ...rest } = fact;
  return rest;
}

function existingAnnotations(fact: Record<string, unknown>): Record<string, unknown>[] {
  const raw = fact.conditionAnnotations;
  if (Array.isArray(raw)) {
    return raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x));
  }
  if (isConditionRefFact(fact)) {
    return [conditionAnnotationFrom(fact)];
  }
  return [];
}

/**
 * Merge a new fact into an existing entry without letting condition_ref overwrite
 * an authoritative payment/entitlement/mapping (etc.) kind or record fields.
 * If a condition_ref arrived first, a later real record replaces that placeholder.
 */
export function mergeEvidenceFact(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (isAuthoritativeFact(existing) && isConditionRefFact(incoming)) {
    const anns = [...existingAnnotations(existing), conditionAnnotationFrom(incoming)];
    return { ...existing, kind: existing.kind, conditionAnnotations: anns };
  }
  if (isConditionRefFact(existing) && isAuthoritativeFact(incoming)) {
    const anns = [...existingAnnotations(existing)];
    const out: Record<string, unknown> = { ...incoming };
    if (anns.length) out.conditionAnnotations = anns;
    return out;
  }
  if (isAuthoritativeFact(existing) && isAuthoritativeFact(incoming)) {
    const priorAnns = existingAnnotations(existing);
    const out: Record<string, unknown> = { ...existing, ...incoming, kind: incoming.kind };
    if (priorAnns.length && !Array.isArray(out.conditionAnnotations)) {
      out.conditionAnnotations = priorAnns;
    }
    return out;
  }
  if (isConditionRefFact(existing) && isConditionRefFact(incoming)) {
    const anns = [...existingAnnotations(existing), conditionAnnotationFrom(incoming)];
    return { kind: "condition_ref", conditionAnnotations: anns };
  }
  // Unknown kinds: prefer not to demote an authoritative record.
  if (isAuthoritativeFact(existing)) {
    return { ...existing, ...incoming, kind: existing.kind };
  }
  return { ...existing, ...incoming };
}

function refStableKey(r: SourceRef): string {
  const ver = r.version === undefined ? "" : `@v${r.version}`;
  return `${r.source}|${r.table}|${sortedKeyEntries(r.key)}|${r.via}${ver}`;
}

const ID_RE = /^e[1-9][0-9]*$/;

export function isEvidenceIdShape(v: unknown): v is EvidenceId {
  return typeof v === "string" && ID_RE.test(v);
}

export class EvidenceRegistry {
  private seq = 0;
  private byId = new Map<EvidenceId, EvidenceEntry>();
  private byRefKey = new Map<string, EvidenceId>();

  get size(): number {
    return this.byId.size;
  }

  /** Register a scoped observed SourceRef; stable ID for identical refs in this run. */
  register(ref: SourceRef, fact: Record<string, unknown>): EvidenceId {
    const rk = refStableKey(ref);
    const existing = this.byRefKey.get(rk);
    if (existing) {
      const ent = this.byId.get(existing)!;
      ent.fact = mergeEvidenceFact(ent.fact, fact);
      return existing;
    }
    this.seq += 1;
    const id: EvidenceId = `e${this.seq}`;
    const entry: EvidenceEntry = { id, ref: structuredClone(ref), fact: { ...fact } };
    this.byId.set(id, entry);
    this.byRefKey.set(rk, id);
    return id;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  idFor(ref: SourceRef): EvidenceId | undefined {
    return this.byRefKey.get(refStableKey(ref));
  }

  /** Lookup registered entry (ref + trusted fact). Unknown / foreign IDs fail closed. */
  lookup(id: string): EvidenceEntry {
    if (!isEvidenceIdShape(id)) {
      throw new Error(`invalid evidence id shape: ${JSON.stringify(id)}`);
    }
    const ent = this.byId.get(id);
    if (!ent) throw new Error(`unknown or foreign evidence id: ${id}`);
    return { id: ent.id, ref: structuredClone(ent.ref), fact: { ...ent.fact } };
  }

  /** Resolve a model-cited ID to the exact original SourceRef. */
  resolve(id: string): SourceRef {
    return this.lookup(id).ref;
  }

  resolveAll(ids: string[], label: string): SourceRef[] {
    return ids.map((id, i) => {
      try {
        return this.resolve(id);
      } catch (e) {
        throw new Error(`${label}[${i}]: ${(e as Error).message}`);
      }
    });
  }

  /** Catalog for model prompts / corrections (full fact values, evidenceId instead of ref). */
  catalog(): Array<{ evidenceId: EvidenceId } & Record<string, unknown>> {
    return [...this.byId.values()].map((e) => ({
      evidenceId: e.id,
      ...e.fact,
    }));
  }

  listIds(): EvidenceId[] {
    return [...this.byId.keys()];
  }
}

/** Replace `ref` on a record with `evidenceId` for model-facing payloads. */
export function withEvidenceId<T extends { ref: SourceRef }>(
  record: T,
  registry: EvidenceRegistry,
): Omit<T, "ref"> & { evidenceId: EvidenceId } {
  const id = registry.idFor(record.ref);
  if (!id) throw new Error("record ref not registered as evidence");
  const { ref: _r, ...rest } = record;
  return { ...(rest as Omit<T, "ref">), evidenceId: id };
}
