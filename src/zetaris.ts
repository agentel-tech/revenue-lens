// Minimal Zetaris client over the platform's REST proxy (no Java needed).
// Logs in once, then runs one Lightning SQL statement per call through the
// SQL editor endpoint, which accepts DDL as well as SELECT.
//
// Credentials: ZETARIS_EMAIL / ZETARIS_PASSWORD, or, for a local install,
// ZETARIS_PLATFORM_DIR pointing at the zetaris-platform folder (its .env is read
// at runtime; nothing is copied into this repo).

import fs from "node:fs";
import path from "node:path";
import "./sources.ts"; // loads .env files

export interface QueryResult {
  headers: string[];
  data: (string | null)[][];
  total: number;
  timeUsed: number;
}

function platformEnv(key: string): string | undefined {
  const dir = process.env.ZETARIS_PLATFORM_DIR?.replace(/^~/, process.env.HOME ?? "~");
  if (!dir) return undefined;
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith(`${key}=`)).pop();
  return line?.slice(key.length + 1);
}

export class Zetaris {
  private token = "";
  private orgId = "";
  constructor(private baseUrl = process.env.ZETARIS_URL ?? "http://localhost:3000") {}

  async login(): Promise<void> {
    const username = process.env.ZETARIS_EMAIL ?? platformEnv("ZETARIS_ADMIN_EMAIL");
    const password = process.env.ZETARIS_PASSWORD ?? platformEnv("ZETARIS_ADMIN_PASSWORD");
    if (!username || !password) throw new Error("Set ZETARIS_EMAIL/ZETARIS_PASSWORD or ZETARIS_PLATFORM_DIR in .env");
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    const token = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.exec(text)?.[0];
    const orgId = /"orgId"\s*:\s*(\d+)/.exec(text)?.[1];
    if (!res.ok || !token || !orgId) throw new Error(`Zetaris login failed (${res.status})`);
    this.token = token;
    this.orgId = orgId;
  }

  async sql(statement: string, limit = 1000): Promise<QueryResult> {
    if (!this.token) await this.login();
    const res = await fetch(`${this.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-Org-ID": this.orgId,
        "X-Request-ID": crypto.randomUUID(),
      },
      body: JSON.stringify({ sql: statement, limit }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Zetaris ${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as QueryResult;
    if (!Array.isArray(parsed.headers)) throw new Error(`Zetaris returned no result set: ${text.slice(0, 300)}`);
    return parsed;
  }
}

// Rows as objects, keyed by column header.
export function records(r: QueryResult): Record<string, string | null>[] {
  return r.data.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])));
}
