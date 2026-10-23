// Sandbox product service: the thing the customer actually uses. It answers
// one question per request: does this signed-in user's workspace hold an
// active, in-period entitlement for the feature? It reads the entitlements
// source directly (never through Zetaris), so a repaired entitlement shows up
// on the very next request.
//
//   npx tsx services/sandbox/server.ts            # http://127.0.0.1:8790
//   curl -H "Authorization: Bearer <token>" http://127.0.0.1:8790/w/<workspace>/features/reports

import http from "node:http";
import { pool } from "../../src/sources.ts";

const PORT = Number(process.env.SANDBOX_PORT) || 8790;
const db = pool("entitlements", "service");

type Session = { tenant_id: string; user_id: string; workspace_id: string };

async function sessionFor(req: http.IncomingMessage): Promise<Session | null> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token) return null;
  const { rows } = await db.query<Session>("SELECT tenant_id, user_id, workspace_id FROM sandbox_sessions WHERE token = $1", [token]);
  return rows[0] ?? null;
}

function send(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

    const m = /^\/w\/([^/]+)\/features\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "GET" || !m) return send(res, 404, { error: "Not found" });
    const [, workspace, feature] = m;

    // Identity comes from the server-side session, never from request headers.
    const session = await sessionFor(req);
    if (!session) return send(res, 401, { error: "Unauthorized", reason: "unknown or missing test token" });
    if (session.workspace_id !== workspace) {
      return send(res, 403, { error: "Access denied", reason: "user is not a member of this workspace" });
    }

    const { rows } = await db.query(
      `SELECT entitlement_id, version FROM entitlements
        WHERE tenant_id = $1 AND target_workspace_id = $2 AND feature = $3
          AND status = 'active' AND period_start <= now() AND now() < period_end
        LIMIT 1`,
      [session.tenant_id, workspace, feature],
    );
    if (rows.length === 0) {
      return send(res, 403, { error: "Access denied", reason: `no active ${feature} entitlement for this workspace`, workspace, feature });
    }
    return send(res, 200, {
      workspace,
      feature,
      entitlement_id: rows[0].entitlement_id,
      content: `Sandbox ${feature}: weekly revenue summary for ${workspace} (test content)`,
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "Internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`sandbox service on http://127.0.0.1:${PORT}`));
