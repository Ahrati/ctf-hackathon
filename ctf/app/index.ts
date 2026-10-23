import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pool, initDb } from "./db";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_COOKIE = "ctf_session";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 12);
if (!Number.isInteger(SESSION_DAYS) || SESSION_DAYS < 1 || SESSION_DAYS > 365) {
  throw new Error("SESSION_DAYS must be a whole number from 1 to 365.");
}
const CTFD_URL = (process.env.CTFD_URL || "").replace(/\/$/, "");
const CTFD_TOKEN = process.env.CTFD_TOKEN || "";
function parseJsonObjectEnv(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a JSON object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${name} must contain a JSON object.`);
  }
}
const CTFD_TEAM_TOKENS: Record<string, string> = Object.fromEntries(Object.entries(parseJsonObjectEnv("CTFD_TEAM_TOKENS_JSON"))
  .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
const CTFD_CHALLENGE_IDS: Record<string, number> = {};
for (const [localId, rawCtfdId] of Object.entries(parseJsonObjectEnv("CTFD_CHALLENGE_IDS_JSON"))) {
  const ctfdId = Number(rawCtfdId);
  if (/^[1-6]$/.test(localId) && Number.isInteger(ctfdId) && ctfdId > 0) CTFD_CHALLENGE_IDS[localId] = ctfdId;
}
const PUBLIC_DIR = resolve(import.meta.dir, "public");
const CHALLENGE_DIR = resolve(import.meta.dir, "challenges");
const FILES_DIR = resolve(PUBLIC_DIR, "files");
const STARTED = new Date().toISOString();

type User = { id: number; username: string; display_name: string; role: "admin" | "team" };
type Authed = { user: User; sessionId: number; tokenHash: string };
type Challenge = { id: number; title: string; data: string; file: string | null; flag: string };

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const flagAttempts = new Map<string, { count: number; resetAt: number }>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}
function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") || "";
  for (const piece of cookie.split(";")) {
    const index = piece.indexOf("=");
    if (index < 0) continue;
    if (piece.slice(0, index).trim() === name) {
      try { return decodeURIComponent(piece.slice(index + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
function requestIp(req: Request, server: Bun.Server<unknown>): string {
  return server.requestIP(req)?.address || "unknown";
}
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.get("host");
  } catch {
    return false;
  }
}
async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}
async function authenticated(req: Request, touch = true): Promise<Authed | null> {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = sha256(raw);
  const [rows] = await pool.query<any[]>(`
    SELECT s.id AS sessionId, s.token_hash AS tokenHash, u.id, u.username, u.display_name, u.role
    FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
    LIMIT 1`, [tokenHash]);
  if (!rows.length) return null;
  const row = rows[0];
  if (touch) {
    await pool.query("UPDATE Event_Sessions SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?", [row.sessionId]);
  }
  return {
    user: { id: Number(row.id), username: row.username, display_name: row.display_name, role: row.role },
    sessionId: Number(row.sessionId), tokenHash: row.tokenHash,
  };
}
async function requireUser(req: Request): Promise<Authed | Response> {
  const auth = await authenticated(req);
  if (!auth) return json({ error: "Please log in." }, 401);
  if (auth.user.role !== "team") return json({ error: "Team account access required." }, 403);
  return auth;
}
async function requireAdmin(req: Request): Promise<Authed | Response> {
  const auth = await authenticated(req);
  if (!auth) return json({ error: "Please log in." }, 401);
  if (auth.user.role !== "admin") return json({ error: "Administrator access required." }, 403);
  return auth;
}
function isResponse(value: unknown): value is Response { return value instanceof Response; }

// CSV reader for the challenge format: header row + one or more rows. Supports quoted commas/newlines.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((item) => item.some((v) => v.trim() !== ""));
}
async function loadChallenge(id: number): Promise<Challenge | null> {
  if (!Number.isInteger(id) || id < 1 || id > 6) return null;
  const filePath = resolve(CHALLENGE_DIR, `challenge-${id}.csv`);
  if (!existsSync(filePath)) return null;
  const rows = parseCsv(await readFile(filePath, "utf8"));
  if (rows.length < 2) throw new Error(`challenge-${id}.csv must contain a header and a data row.`);
  const headerRow = rows[0] ?? [];
  const header = headerRow.map((cell) => cell.trim().replace(/^\uFEFF/, "").toLowerCase());
  const values = rows[1] ?? [];
  const get = (name: string) => {
    const index = header.indexOf(name);
    return index < 0 ? "" : (values[index] ?? "").trim();
  };
  const data = get("data");
  const flag = get("flag");
  if (!data || !/^[\s\S]{8}$/.test(flag)) throw new Error(`challenge-${id}.csv must have a non-empty data field and an 8-character flag.`);
  const file = get("file") || null;
  if (file && (!file.startsWith("/files/") || file.includes("..") || file.includes("\\"))) {
    throw new Error(`challenge-${id}.csv file must be a safe /files/... route.`);
  }
  return { id, title: get("title") || `Challenge ${id}`, data, file, flag };
}
async function allChallenges(includeData = false) {
  const [stateRows] = await pool.query<any[]>("SELECT challenge_id, enabled FROM Event_Challenge_State ORDER BY challenge_id");
  const stateMap = new Map<number, number>(stateRows.map((r) => [Number(r.challenge_id), Number(r.enabled)]));
  const out: any[] = [];
  for (let id = 1; id <= 6; id++) {
    const challenge = await loadChallenge(id);
    const [solves] = await pool.query<any[]>(`
      SELECT s.placement, s.points, s.solved_at, u.display_name
      FROM Event_Solves s JOIN Event_Users u ON u.id = s.user_id
      WHERE s.challenge_id = ? ORDER BY s.placement ASC LIMIT 1`, [id]);
    out.push({
      id, title: challenge?.title || `Challenge ${id}`, enabled: stateMap.get(id) !== 0,
      solved: solves.length > 0,
      firstPlace: solves.length ? solves[0].display_name : null,
      firstSolvedAt: solves.length ? solves[0].solved_at : null,
      ...(includeData && challenge ? { data: challenge.data, file: challenge.file } : {}),
    });
  }
  return out;
}
async function leaderboard() {
  const [rows] = await pool.query<any[]>(`
    SELECT u.id AS teamId, u.display_name AS team, COALESCE(SUM(s.points), 0) AS points,
      COUNT(s.id) AS solved, MAX(s.solved_at) AS lastSolve
    FROM Event_Users u LEFT JOIN Event_Solves s ON s.user_id = u.id
    WHERE u.role = 'team'
    GROUP BY u.id, u.display_name
    ORDER BY points DESC, solved DESC, lastSolve ASC, team ASC`);
  return rows.map((r, index) => ({ rank: index + 1, teamId: Number(r.teamId), team: r.team, points: Number(r.points), solved: Number(r.solved), lastSolve: r.lastSolve }));
}
async function getPoints() {
  const [rows] = await pool.query<any[]>("SELECT challenge_id, placement, points FROM Event_Challenge_Points ORDER BY challenge_id, placement");
  const grouped: Record<number, number[]> = {};
  for (const row of rows) {
    const id = Number(row.challenge_id), place = Number(row.placement);
    grouped[id] ||= [];
    grouped[id][place - 1] = Number(row.points);
  }
  return grouped;
}
async function ctfdFetch(endpoint: string): Promise<any> {
  if (!CTFD_URL || !CTFD_TOKEN) throw new Error("Set CTFD_URL and CTFD_TOKEN to enable the read-only CTFd scoreboard integration.");
  const response = await fetch(`${CTFD_URL}/api/v1/${endpoint}`, {
    headers: { Authorization: `Token ${CTFD_TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`CTFd returned HTTP ${response.status}.`);
  try { return JSON.parse(body); } catch { throw new Error("CTFd returned invalid JSON."); }
}
let ctfdScoreboardCache: { fetchedAt: number; value: any } | null = null;
async function getCtfdScoreboard() {
  if (ctfdScoreboardCache && Date.now() - ctfdScoreboardCache.fetchedAt < 10_000) return ctfdScoreboardCache.value;
  const value = await ctfdFetch("scoreboard");
  ctfdScoreboardCache = { fetchedAt: Date.now(), value };
  return value;
}
async function syncSolveToCtfd(username: string, localChallengeId: number, submission: string) {
  const teamToken = CTFD_TEAM_TOKENS[username];
  const ctfdChallengeId = CTFD_CHALLENGE_IDS[String(localChallengeId)];
  const hasTeamToken = typeof teamToken === "string" && teamToken.length > 0;
  const hasChallengeMapping = Boolean(ctfdChallengeId);
  if (!CTFD_URL || (!hasTeamToken && !hasChallengeMapping)) {
    return { configured: false, ok: false, message: "No per-team CTFd mapping configured; local score recorded." };
  }
  if (!hasTeamToken || !hasChallengeMapping) {
    return { configured: true, ok: false, message: `Missing ${!hasTeamToken ? `CTFD_TEAM_TOKENS_JSON entry for ${username}` : `CTFD_CHALLENGE_IDS_JSON entry for challenge ${localChallengeId}`}.` };
  }
  try {
    const response = await fetch(`${CTFD_URL}/api/v1/challenges/attempt`, {
      method: "POST",
      headers: { Authorization: `Token ${teamToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ challenge_id: ctfdChallengeId, submission }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    let payload: any = {};
    try { payload = JSON.parse(body); } catch { /* response may be an HTML error page */ }
    const status = payload?.data?.status ?? payload?.status;
    const ok = response.ok && ["correct", "already_solved", "already-solved"].includes(String(status));
    return { configured: true, ok, message: ok ? "CTFd scoreboard updated." : `CTFd sync did not confirm the solve (HTTP ${response.status}${status ? `, ${status}` : ""}).` };
  } catch {
    return { configured: true, ok: false, message: "CTFd could not be reached; local score was still recorded." };
  }
}
async function servePublic(path: string): Promise<Response> {
  if (path === "/" || path === "/login") return new Response(Bun.file(resolve(PUBLIC_DIR, "index.html")), { headers: { "Cache-Control": "no-store" } });
  if (path === "/admin") return new Response(Bun.file(resolve(PUBLIC_DIR, "admin.html")), { headers: { "Cache-Control": "no-store" } });
  if (path === "/tv") return new Response(Bun.file(resolve(PUBLIC_DIR, "tv.html")), { headers: { "Cache-Control": "no-store" } });
  if (path === "/challenges" || /^\/challenges\/[1-6]$/.test(path)) return new Response(Bun.file(resolve(PUBLIC_DIR, "challenges.html")), { headers: { "Cache-Control": "no-store" } });
  if (path.startsWith("/css/") || path.startsWith("/js/")) {
    const target = resolve(PUBLIC_DIR, `.${path}`);
    if (!target.startsWith(`${PUBLIC_DIR}${sep}`)) return new Response("Not found", { status: 404 });
    if (!existsSync(target)) return new Response("Not found", { status: 404 });
    const ext = extname(target);
    const types: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    return new Response(Bun.file(target), { headers: { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" } });
  }
  if (path.startsWith("/files/")) {
    if (path.includes("..") || path.includes("\\")) return new Response("Not found", { status: 404 });
    const target = resolve(FILES_DIR, decodeURIComponent(path.slice("/files/".length)));
    if (!target.startsWith(`${FILES_DIR}${sep}`) || !existsSync(target)) return new Response("Not found", { status: 404 });
    const realTarget = await realpath(target);
    const realFiles = await realpath(FILES_DIR);
    if (!realTarget.startsWith(`${realFiles}${sep}`) || !(await stat(realTarget)).isFile()) return new Response("Not found", { status: 404 });
    const filename = realTarget.split(sep).pop()!.replace(/[\r\n"\\]/g, "_");
    return new Response(Bun.file(realTarget), { headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    } });
  }
  return new Response("Not found", { status: 404 });
}

await initDb();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    try {
      if (path.startsWith("/api/") && method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
        return json({ error: "Cross-origin request rejected." }, 403);
      }

      // Authentication endpoints.
      if (path === "/api/login" && method === "POST") {
        const ip = requestIp(req, server);
        const now = Date.now();
        const rate = loginAttempts.get(ip);
        if (rate && rate.resetAt > now && rate.count >= 12) return json({ error: "Too many login attempts. Wait five minutes and try again." }, 429);
        if (!rate || rate.resetAt <= now) loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
        else rate.count++;

        const body = await readJson(req);
        const username = String(body?.username || "").trim();
        const password = String(body?.password || "");
        if (!username || !password || username.length > 191 || password.length > 1024) return json({ error: "Enter your username and password." }, 400);
        const [rows] = await pool.query<any[]>("SELECT id, username, display_name, password_hash, role FROM Event_Users WHERE username = ? LIMIT 1", [username]);
        const account = rows[0];
        const valid = account ? await Bun.password.verify(password, account.password_hash).catch(() => false) : false;
        if (!valid) return json({ error: "Incorrect username or password." }, 401);

        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = sha256(rawToken);
        const userAgent = (req.headers.get("user-agent") || "unknown").slice(0, 512);
        await pool.query(`INSERT INTO Event_Sessions (user_id, token_hash, expires_at, ip_address, user_agent)
          VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), ?, ?)`, [account.id, tokenHash, SESSION_DAYS, ip, userAgent]);
        loginAttempts.delete(ip);
        const secure = url.protocol === "https:" ? "; Secure" : "";
        const cookie = `${SESSION_COOKIE}=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
        return json({ ok: true, user: { id: Number(account.id), username: account.username, displayName: account.display_name, role: account.role }, redirect: account.role === "admin" ? "/admin" : "/challenges" }, 200, { "Set-Cookie": cookie });
      }
      if (path === "/api/logout" && method === "POST") {
        const raw = cookieValue(req, SESSION_COOKIE);
        if (raw) await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL", [sha256(raw)]);
        return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (path === "/api/me" && method === "GET") {
        const auth = await authenticated(req);
        if (!auth) return json({ authenticated: false }, 401);
        return json({ authenticated: true, user: { id: auth.user.id, username: auth.user.username, displayName: auth.user.display_name, role: auth.user.role } });
      }

      // Public display: own event standings plus optional read-only CTFd standings.
      if (path === "/api/tv" && method === "GET") {
        const [board, challenges] = await Promise.all([leaderboard(), allChallenges(false)]);
        let ctfd: any = { configured: Boolean(CTFD_URL && CTFD_TOKEN), ok: false, data: null };
        if (CTFD_URL && CTFD_TOKEN) {
          try { const result = await getCtfdScoreboard(); ctfd = { configured: true, ok: true, data: result?.data ?? result }; }
          catch (error: any) { ctfd = { configured: true, ok: false, error: error.message, data: null }; }
        }
        return json({ eventStartedAt: STARTED, updatedAt: new Date().toISOString(), leaderboard: board, challenges, ctfd });
      }
      if (path === "/api/ctfd/scoreboard" && method === "GET") {
        try { return json({ configured: true, data: await getCtfdScoreboard() }); }
        catch (error: any) { return json({ configured: Boolean(CTFD_URL && CTFD_TOKEN), error: error.message }, 502); }
      }

      // Team/member routes.
      if (path === "/api/challenges" && method === "GET") {
        const auth = await requireUser(req); if (isResponse(auth)) return auth;
        const all = await allChallenges(true);
        const [solved] = await pool.query<any[]>("SELECT challenge_id, placement, points, solved_at FROM Event_Solves WHERE user_id = ?", [auth.user.id]);
        const solvedMap = new Map<number, any>(solved.map((item) => [Number(item.challenge_id), item]));
        return json({ challenges: all.map((item) => ({ ...item, data: undefined, file: undefined, solve: solvedMap.get(item.id) || null })) });
      }
      const challengeMatch = path.match(/^\/api\/challenges\/([1-6])$/);
      if (challengeMatch && method === "GET") {
        const auth = await requireUser(req); if (isResponse(auth)) return auth;
        const challenge = await loadChallenge(Number(challengeMatch[1]));
        if (!challenge) return json({ error: "Challenge not found." }, 404);
        const [state] = await pool.query<any[]>("SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ?", [challenge.id]);
        if (!state.length || !Number(state[0].enabled)) return json({ error: "This challenge is currently disabled." }, 403);
        const [solveRows] = await pool.query<any[]>("SELECT placement, points, solved_at FROM Event_Solves WHERE user_id = ? AND challenge_id = ?", [auth.user.id, challenge.id]);
        return json({ challenge: { id: challenge.id, title: challenge.title, data: challenge.data, file: challenge.file }, solve: solveRows[0] || null });
      }
      const submitMatch = path.match(/^\/api\/challenges\/([1-6])\/submit$/);
      if (submitMatch && method === "POST") {
        const auth = await requireUser(req); if (isResponse(auth)) return auth;
        const rateKey = `${requestIp(req, server)}:${auth.tokenHash}`;
        const now = Date.now(); const rate = flagAttempts.get(rateKey);
        if (rate && rate.resetAt > now && rate.count >= 20) return json({ error: "Too many flag attempts. Wait one minute and try again." }, 429);
        if (!rate || rate.resetAt <= now) flagAttempts.set(rateKey, { count: 1, resetAt: now + 60_000 }); else rate.count++;
        const challengeId = Number(submitMatch[1]);
        const body = await readJson(req);
        const provided = String(body?.flag || "").trim();
        if (provided.length !== 8) return json({ correct: false, error: "Flags must be 8 characters." }, 400);
        const challenge = await loadChallenge(challengeId);
        if (!challenge) return json({ error: "Challenge not found." }, 404);
        const conn = await pool.getConnection();
        let placement = 0;
        let points = 0;
        let alreadySolved = false;
        try {
          await conn.beginTransaction();
          const [stateRows] = await conn.query<any[]>("SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ? FOR UPDATE", [challengeId]);
          if (!stateRows.length || !Number(stateRows[0].enabled)) { await conn.rollback(); return json({ error: "This challenge is currently disabled." }, 403); }
          const [existing] = await conn.query<any[]>("SELECT placement, points, solved_at FROM Event_Solves WHERE user_id = ? AND challenge_id = ?", [auth.user.id, challengeId]);
          if (provided !== challenge.flag) { await conn.rollback(); return json({ correct: false, error: "Incorrect flag. Try again." }, 200); }
          if (existing.length) {
            await conn.rollback();
            placement = Number(existing[0].placement);
            points = Number(existing[0].points);
            alreadySolved = true;
          } else {
            const [countRows] = await conn.query<any[]>("SELECT COUNT(*) AS count FROM Event_Solves WHERE challenge_id = ?", [challengeId]);
            placement = Number(countRows[0].count) + 1;
            const [pointRows] = await conn.query<any[]>("SELECT points FROM Event_Challenge_Points WHERE challenge_id = ? AND placement <= ? ORDER BY placement DESC LIMIT 1", [challengeId, placement]);
            points = pointRows.length ? Number(pointRows[0].points) : 0;
            await conn.query("INSERT INTO Event_Solves (user_id, challenge_id, placement, points) VALUES (?, ?, ?, ?)", [auth.user.id, challengeId, placement, points]);
            await conn.commit();
          }
        } catch (error) {
          await conn.rollback(); throw error;
        } finally { conn.release(); }
        const ctfdSync = await syncSolveToCtfd(auth.user.username, challengeId, provided);
        const message = placement === 1 ? "Correct! First place on this challenge." : "Correct! Flag captured.";
        return json({ correct: true, alreadySolved, placement, points, message, ctfdSync });
      }
      if (path === "/api/leaderboard" && method === "GET") return json({ leaderboard: await leaderboard() });

      // Administrator-only API.
      if (path.startsWith("/api/admin/")) {
        const auth = await requireAdmin(req); if (isResponse(auth)) return auth;
        if (path === "/api/admin/overview" && method === "GET") {
          const [board, challenges, points] = await Promise.all([leaderboard(), allChallenges(false), getPoints()]);
          const [sessionRows] = await pool.query<any[]>(`SELECT COUNT(*) AS total,
            SUM(CASE WHEN revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() AND last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND) THEN 1 ELSE 0 END) AS online
            FROM Event_Sessions`);
          return json({ leaderboard: board, challenges, points, sessions: { total: Number(sessionRows[0].total || 0), online: Number(sessionRows[0].online || 0) }, ctfdConfigured: Boolean(CTFD_URL && CTFD_TOKEN) });
        }
        if (path === "/api/admin/sessions" && method === "GET") {
          const [rows] = await pool.query<any[]>(`SELECT s.id, s.user_id AS userId, u.username, u.display_name AS displayName, u.role,
            s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
            s.ip_address AS ipAddress, s.user_agent AS userAgent,
            (s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)) AS online
            FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
            ORDER BY s.created_at DESC LIMIT 500`);
          return json({ sessions: rows.map((r) => ({ ...r, id: Number(r.id), userId: Number(r.userId), online: Boolean(r.online) })) });
        }
        const revokeMatch = path.match(/^\/api\/admin\/sessions\/(\d+)\/revoke$/);
        if (revokeMatch && method === "POST") {
          const id = Number(revokeMatch[1]);
          const [result]: any = await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL", [id]);
          return json({ ok: true, revoked: Number(result.affectedRows || 0) > 0 });
        }
        const revokeUserMatch = path.match(/^\/api\/admin\/users\/(\d+)\/revoke-sessions$/);
        if (revokeUserMatch && method === "POST") {
          const userId = Number(revokeUserMatch[1]);
          if (userId === auth.user.id) return json({ error: "Use logout instead of revoking your own admin sessions." }, 400);
          const [result]: any = await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL", [userId]);
          return json({ ok: true, revoked: Number(result.affectedRows || 0) });
        }
        const pointsMatch = path.match(/^\/api\/admin\/challenges\/([1-6])\/points$/);
        if (pointsMatch && method === "POST") {
          const id = Number(pointsMatch[1]);
          const body = await readJson(req);
          if (!Array.isArray(body?.points) || body.points.length < 1 || body.points.length > 20 || body.points.some((n: any) => !Number.isInteger(n) || n < 0 || n > 100000)) {
            return json({ error: "Provide 1–20 whole-number point values from 0 to 100000 (place 1 first)." }, 400);
          }
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            await conn.query("SELECT challenge_id FROM Event_Challenge_State WHERE challenge_id = ? FOR UPDATE", [id]);
            await conn.query("DELETE FROM Event_Challenge_Points WHERE challenge_id = ?", [id]);
            for (let i = 0; i < body.points.length; i++) {
              await conn.query("INSERT INTO Event_Challenge_Points (challenge_id, placement, points) VALUES (?, ?, ?)", [id, i + 1, body.points[i]]);
            }
            await conn.query(`UPDATE Event_Solves s SET points = COALESCE(
              (SELECT p.points FROM Event_Challenge_Points p WHERE p.challenge_id = s.challenge_id AND p.placement <= s.placement ORDER BY p.placement DESC LIMIT 1), 0
              ) WHERE s.challenge_id = ?`, [id]);
            await conn.commit();
            return json({ ok: true, points: body.points });
          } catch (error) { await conn.rollback(); throw error; }
          finally { conn.release(); }
        }
        const enableMatch = path.match(/^\/api\/admin\/challenges\/([1-6])\/enabled$/);
        if (enableMatch && method === "POST") {
          const id = Number(enableMatch[1]); const body = await readJson(req);
          if (typeof body?.enabled !== "boolean") return json({ error: "enabled must be true or false." }, 400);
          await pool.query("UPDATE Event_Challenge_State SET enabled = ? WHERE challenge_id = ?", [body.enabled ? 1 : 0, id]);
          return json({ ok: true, enabled: body.enabled });
        }
        if (path === "/api/admin/ctfd/scoreboard" && method === "GET") {
          try { return json({ configured: true, data: await getCtfdScoreboard() }); }
          catch (error: any) { return json({ configured: Boolean(CTFD_URL && CTFD_TOKEN), error: error.message }, 502); }
        }
      }

      // Public TV page; all other app pages use session/role checks.
      if (path === "/tv") return servePublic(path);
      // Page protection and role-based redirects.
      if (!path.startsWith("/api/") && (["/", "/login", "/admin", "/challenges"].includes(path) || /^\/challenges\/[1-6]$/.test(path))) {
        const auth = await authenticated(req, false);
        if (auth) {
          if (path === "/" || path === "/login") return redirect(auth.user.role === "admin" ? "/admin" : "/challenges");
          if (path === "/admin" && auth.user.role !== "admin") return redirect("/challenges");
          if ((path === "/challenges" || /^\/challenges\/[1-6]$/.test(path)) && auth.user.role === "admin") return redirect("/admin");
          return servePublic(path);
        }
        if (path === "/admin" || path === "/challenges" || /^\/challenges\/[1-6]$/.test(path)) return redirect("/login");
        return servePublic(path);
      }
      if (path.startsWith("/files/")) {
        const auth = await authenticated(req, false);
        if (!auth) return redirect("/login");
        let decodedPath: string;
        try { decodedPath = decodeURIComponent(path); } catch { return new Response("Not found", { status: 404 }); }
        let referenced = false;
        for (let id = 1; id <= 6; id++) {
          const challenge = await loadChallenge(id);
          if (challenge?.file === decodedPath) {
            const [states] = await pool.query<any[]>("SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ?", [id]);
            if (states.length && Number(states[0].enabled)) referenced = true;
            break;
          }
        }
        if (!referenced) return new Response("Not found", { status: 404 });
        return servePublic(path);
      }
      if (path.startsWith("/css/") || path.startsWith("/js/")) return servePublic(path);
      return new Response("Not found", { status: 404 });
    } catch (error: any) {
      console.error(`${method} ${path}:`, error?.stack || error);
      if (path.startsWith("/api/")) return json({ error: "An internal server error occurred." }, 500);
      return new Response("Internal server error", { status: 500 });
    }
  },
});

console.log(`CTF app listening on http://${HOST}:${server.port}`);
console.log(`For other laptops on the same LAN, open http://<server-laptop-LAN-IP>:${PORT}`);
