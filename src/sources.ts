// Connection settings for the three sandbox sources (infra/docker-compose.yml).
// Host-side access goes through 127.0.0.1 ports; Zetaris reaches the same
// databases by container name on the zetaris_default network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { SourceName } from "./contracts.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [path.join(root, ".env"), path.join(root, "infra/.env")]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export type { SourceName };
export type Role = "owner" | "reader" | "service" | "executor";

export const SOURCES: Record<SourceName, { container: string; database: string; hostPort: number }> = {
  billing: { container: "rl-billing", database: "billing", hostPort: 55431 },
  workspace_map: { container: "rl-workspace-map", database: "workspace_map", hostPort: 55432 },
  entitlements: { container: "rl-entitlements", database: "entitlements", hostPort: 55433 },
};

const ROLE_USER: Record<Role, string> = { owner: "rl_owner", reader: "zetaris_reader", service: "rl_service", executor: "rl_executor" };
const ROLE_ENV: Record<Role, string> = {
  owner: "RL_OWNER_PASSWORD",
  reader: "RL_READER_PASSWORD",
  service: "RL_SERVICE_PASSWORD",
  executor: "RL_EXECUTOR_PASSWORD",
};

export function credentials(role: Role): { user: string; password: string } {
  const password = process.env[ROLE_ENV[role]];
  if (!password) throw new Error(`${ROLE_ENV[role]} is not set (copy infra/.env.example to infra/.env)`);
  return { user: ROLE_USER[role], password };
}

export function pool(source: SourceName, role: Role): pg.Pool {
  const { user, password } = credentials(role);
  return new pg.Pool({ host: "127.0.0.1", port: SOURCES[source].hostPort, database: SOURCES[source].database, user, password, max: 4 });
}
