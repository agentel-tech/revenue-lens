import type { AccessProbe } from "../src/contracts.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Real HTTP probe of the sandbox product service. Never logs the token. */
export async function probeCustomerAccess(opts: {
  baseUrl: string;
  workspace: string;
  feature: string;
  token: string;
  timeoutMs?: number;
}): Promise<AccessProbe> {
  const at = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const res = await fetch(
    `${opts.baseUrl.replace(/\/$/, "")}/w/${encodeURIComponent(opts.workspace)}/features/${encodeURIComponent(opts.feature)}`,
    {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = { error: "non-json body" };
  }
  return { workspace: opts.workspace, feature: opts.feature, status: res.status, body, at };
}
