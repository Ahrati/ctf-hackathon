import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { PoolConnection } from "mysql2/promise";
import { pool, initDb } from "./db";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_COOKIE = "ctf_session";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 12);
if (!Number.isInteger(SESSION_DAYS) || SESSION_DAYS < 1 || SESSION_DAYS > 365) {
  throw new Error("SESSION_DAYS must be a whole number from 1 to 365.");
}
const PUBLIC_DIR = resolve(import.meta.dir, "public");
const CHALLENGE_DIR = resolve(import.meta.dir, "challenges");
const FILES_DIR = resolve(PUBLIC_DIR, "files");
const STARTED = new Date().toISOString();

type User = { id: number; username: string; display_name: string; role: "admin" | "team"; disqualified_at?: string | null };
type Authed = { user: User; sessionId: number; tokenHash: string; personId: number | null; ipAddress: string; userAgent: string };
type Challenge = { id: number; title: string; data: string; file: string | null; flag: string };

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const flagAttempts = new Map<string, { count: number; resetAt: number }>();

// Mutation challenge configuration.
const MUTATION_CHALLENGE_ID = 6;
const MUTATION_HISTORY_LIMIT = 50;
const MUTATION_INTERVAL_MS = 750;

const MUTATION_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// The two digit characters always sum to 12.
const MUTATION_PAIRS = [
  "39",
  "48",
  "57",
  "66",
  "75",
  "84",
  "93",
];

const mutationHistory: string[] = [];

function mutationClock(date: Date): {
  HH: string;
  MM: string;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zagreb",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return {
    HH: parts.find((part) => part.type === "hour")?.value ?? "00",
    MM: parts.find((part) => part.type === "minute")?.value ?? "00",
  };
}

function generateMutationPassword(date: Date): string {
  const { HH, MM } = mutationClock(date);

  const pair =
      MUTATION_PAIRS[randomInt(0, MUTATION_PAIRS.length)]!;

  const r =
      MUTATION_ALPHABET[
          randomInt(0, MUTATION_ALPHABET.length)
          ]!;

  return `${HH}${pair[0]}${r}${pair[1]}${MM}`;
}

// The currently valid password is never included in the history.
let currentMutationPassword =
    generateMutationPassword(new Date());

function rotateMutationPassword(): void {
  mutationHistory.unshift(currentMutationPassword);

  if (mutationHistory.length > MUTATION_HISTORY_LIMIT) {
    mutationHistory.length = MUTATION_HISTORY_LIMIT;
  }

  currentMutationPassword =
      generateMutationPassword(new Date());
}

setInterval(
    rotateMutationPassword,
    MUTATION_INTERVAL_MS,
);

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
async function authenticated(req: Request, touch = true, currentIp?: string): Promise<Authed | null> {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = sha256(raw);
  const [rows] = await pool.query<any[]>(`
    SELECT s.id AS sessionId, s.token_hash AS tokenHash, s.tracked_person_id AS personId,
           s.ip_address AS ipAddress, s.user_agent AS userAgent,
           u.id, u.username, u.display_name, u.role, u.disqualified_at
    FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
      LIMIT 1`, [tokenHash]);
  if (!rows.length) return null;
  const row = rows[0];
  let personId = row.personId ? Number(row.personId) : null;
  let storedIp = normalizedIp(String(row.ipAddress || "unknown"));
  const agent = String(row.userAgent || "");
  const liveIp = currentIp ? normalizedIp(currentIp) : storedIp;
  if (touch) {
    if (row.role === "team" && liveIp !== "unknown" && liveIp !== storedIp) {
      const previousPersonId = personId;
      const previousIp = storedIp;
      const tracked = await getOrCreateTrackedPerson(Number(row.id), liveIp, agent);
      personId = tracked.id;
      storedIp = liveIp;
      await pool.query(`UPDATE Event_Sessions SET last_seen_at = UTC_TIMESTAMP(), disconnected_logged_at = NULL,
        ip_address = ?, tracked_person_id = ? WHERE id = ?`, [liveIp, personId, row.sessionId]);
      if (previousPersonId && previousPersonId !== personId) {
        await logActivity({ teamId: Number(row.id), personId: previousPersonId, sessionId: Number(row.sessionId),
          actorUserId: Number(row.id), eventType: "ip_identity_left",
          details: `Browser session ${row.sessionId} changed from IP ${previousIp} to ${liveIp}. This earlier IP identity may now be disconnected.`,
          ipAddress: previousIp, userAgent: agent });
      }
      await logActivity({ teamId: Number(row.id), personId, sessionId: Number(row.sessionId), actorUserId: Number(row.id),
        eventType: "ip_change_detected",
        details: `Browser session ${row.sessionId} changed IP from ${previousIp} to ${liveIp}. This may be the same person whose IP changed or a different person; review manually. No automatic action was taken.`,
        ipAddress: liveIp, userAgent: agent });
      await logActivity({ teamId: Number(row.id), personId, sessionId: Number(row.sessionId), actorUserId: Number(row.id),
        eventType: "new_ip_observed",
        details: `IP change observed: session ${row.sessionId} moved from ${previousIp} to ${liveIp}. Admin review required; no automatic action was taken.`,
        ipAddress: liveIp, userAgent: agent });
    } else {
      await pool.query("UPDATE Event_Sessions SET last_seen_at = UTC_TIMESTAMP(), disconnected_logged_at = NULL WHERE id = ?", [row.sessionId]);
      if (personId) {
        await pool.query("UPDATE Event_Tracked_People SET last_seen_at = UTC_TIMESTAMP(), last_user_agent = ? WHERE id = ?", [agent, personId]);
      }
    }
  }
  return {
    user: { id: Number(row.id), username: row.username, display_name: row.display_name, role: row.role, disqualified_at: row.disqualified_at ?? null },
    sessionId: Number(row.sessionId), tokenHash: row.tokenHash,
    personId,
    ipAddress: storedIp, userAgent: agent,
  };
}
async function requireUser(req: Request, currentIp?: string): Promise<Authed | Response> {
  const auth = await authenticated(req, true, currentIp);
  if (!auth) return json({ error: "Please log in." }, 401);
  if (auth.user.role !== "team") return json({ error: "Team account access required." }, 403);
  if (auth.user.disqualified_at) return json({ error: "This team has been disqualified and can no longer access the event." }, 403);
  return auth;
}
async function requireAdmin(req: Request, currentIp?: string): Promise<Authed | Response> {
  const auth = await authenticated(req, true, currentIp);
  if (!auth) return json({ error: "Please log in." }, 401);
  if (auth.user.role !== "admin") return json({ error: "Administrator access required." }, 403);
  return auth;
}
function isResponse(value: unknown): value is Response { return value instanceof Response; }

function normalizedIp(ip: string): string {
  const value = String(ip || "unknown").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

async function getOrCreateTrackedPerson(teamId: number, ipAddress: string, userAgent: string, existingConnection?: PoolConnection): Promise<{
  id: number; label: string; isNew: boolean; hasPriorIp: boolean; wasAway: boolean;
}> {
  const ownsConnection = !existingConnection;
  const conn = existingConnection ?? await pool.getConnection();
  try {
    if (ownsConnection) await conn.beginTransaction();
    // Serialize allocations for a team so two simultaneous logins cannot get the same dummy label.
    await conn.query("SELECT id FROM Event_Users WHERE id = ? FOR UPDATE", [teamId]);
    const [rows] = await conn.query<any[]>(`SELECT id, label,
      (last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)) AS wasAway
      FROM Event_Tracked_People WHERE team_id = ? AND ip_address = ? LIMIT 1 FOR UPDATE`, [teamId, ipAddress]);
    let id: number, label: string, isNew = false, hasPriorIp = false, wasAway = false;
    if (rows.length) {
      id = Number(rows[0].id);
      label = String(rows[0].label);
      wasAway = Boolean(rows[0].wasAway);
      await conn.query("UPDATE Event_Tracked_People SET last_seen_at = UTC_TIMESTAMP(), last_user_agent = ? WHERE id = ?", [userAgent, id]);
    } else {
      const [countRows] = await conn.query<any[]>("SELECT COUNT(*) AS count FROM Event_Tracked_People WHERE team_id = ?", [teamId]);
      const count = Number(countRows[0]?.count || 0);
      label = `Person ${count + 1}`;
      const [result]: any = await conn.query(`INSERT INTO Event_Tracked_People
        (team_id, ip_address, label, first_seen_at, last_seen_at, last_user_agent)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)`, [teamId, ipAddress, label, userAgent]);
      id = Number(result.insertId);
      isNew = true;
      hasPriorIp = count > 0;
    }
    if (ownsConnection) await conn.commit();
    return { id, label, isNew, hasPriorIp, wasAway };
  } catch (error) {
    if (ownsConnection) await conn.rollback();
    throw error;
  } finally {
    if (ownsConnection) conn.release();
  }
}

async function logActivity(input: {
  teamId?: number | null; personId?: number | null; sessionId?: number | null; actorUserId?: number | null;
  eventType: string; details: string; ipAddress?: string; userAgent?: string;
}): Promise<void> {
  try {
    await pool.query(`INSERT INTO Event_Activity_Logs
      (team_id, person_id, session_id, actor_user_id, event_type, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.teamId ?? null, input.personId ?? null, input.sessionId ?? null, input.actorUserId ?? null,
      input.eventType.slice(0, 80), input.details.slice(0, 4000), normalizedIp(input.ipAddress || "unknown"),
      String(input.userAgent || "").slice(0, 512),
    ]);
  } catch (error: any) {
    // Logging must not break a legitimate challenge request, but failures remain visible to operators.
    console.error("Activity log insert failed:", error?.message ?? error);
  }
}

async function recordInactiveConnectionEvents(): Promise<void> {
  const [rows] = await pool.query<any[]>(`SELECT s.id AS sessionId, s.user_id AS teamId,
      s.tracked_person_id AS personId, s.ip_address AS ipAddress, s.user_agent AS userAgent,
      s.last_seen_at AS lastSeenAt
    FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
    WHERE u.role = 'team' AND s.tracked_person_id IS NOT NULL AND s.disconnected_logged_at IS NULL
      AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
      AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)
      AND s.last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)
    ORDER BY s.last_seen_at ASC LIMIT 500`);
  for (const row of rows) {
    const [result]: any = await pool.query(`UPDATE Event_Sessions SET disconnected_logged_at = UTC_TIMESTAMP()
      WHERE id = ? AND disconnected_logged_at IS NULL
        AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)`, [row.sessionId]);
    if (!Number(result?.affectedRows || 0)) continue;
    await logActivity({ teamId: Number(row.teamId), personId: Number(row.personId), sessionId: Number(row.sessionId),
      actorUserId: Number(row.teamId), eventType: "connection_inactive",
      details: `Session ${row.sessionId} was marked disconnected after no activity. Last seen: ${row.lastSeenAt}.`,
      ipAddress: String(row.ipAddress || "unknown"), userAgent: String(row.userAgent || "") });
  }
}

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
      WHERE s.challenge_id = ? AND u.role = 'team' AND u.disqualified_at IS NULL
      ORDER BY s.solved_at ASC, s.id ASC LIMIT 1`, [id]);
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
type PlacementChange = {
  solveId: number;
  teamId: number;
  teamName: string;
  challengeId: number;
  originalPlacement: number;
  previousPlacement: number;
  placement: number;
  previousPoints: number;
  points: number;
};

/** Recompute live placements and points among teams that remain eligible. */
async function recalculateEligiblePlacements(conn: PoolConnection, challengeId: number): Promise<PlacementChange[]> {
  const [solves] = await conn.query<any[]>(`
    SELECT s.id AS solveId, s.user_id AS teamId, u.display_name AS teamName,
           s.original_placement AS originalPlacement, s.placement AS previousPlacement,
           s.points AS previousPoints, s.solved_at AS solvedAt
    FROM Event_Solves s
    JOIN Event_Users u ON u.id = s.user_id
    WHERE s.challenge_id = ? AND u.role = 'team' AND u.disqualified_at IS NULL
    ORDER BY s.solved_at ASC, s.id ASC
    FOR UPDATE`, [challengeId]);
  const [schedule] = await conn.query<any[]>(
    "SELECT placement, points FROM Event_Challenge_Points WHERE challenge_id = ? ORDER BY placement ASC",
    [challengeId],
  );
  const changes: PlacementChange[] = [];
  for (let index = 0; index < solves.length; index++) {
    const solve = solves[index];
    const placement = index + 1;
    const applicable = schedule.filter((row) => Number(row.placement) <= placement);
    const points = applicable.length ? Number(applicable[applicable.length - 1].points) : 0;
    const previousPlacement = Number(solve.previousPlacement);
    const previousPoints = Number(solve.previousPoints);
    const originalPlacement = Number(solve.originalPlacement || solve.previousPlacement);
    await conn.query("UPDATE Event_Solves SET placement = ?, points = ?, original_placement = COALESCE(original_placement, ?) WHERE id = ?",
      [placement, points, originalPlacement, solve.solveId]);
    if (placement !== previousPlacement || points !== previousPoints) {
      changes.push({
        solveId: Number(solve.solveId), teamId: Number(solve.teamId), teamName: String(solve.teamName), challengeId,
        originalPlacement, previousPlacement, placement, previousPoints, points,
      });
    }
  }
  return changes;
}

async function leaderboard() {
  const [rows] = await pool.query<any[]>(`
    SELECT u.id AS teamId, u.display_name AS team, COALESCE(SUM(s.points), 0) AS points,
           COUNT(s.id) AS solved, MAX(s.solved_at) AS lastSolve
    FROM Event_Users u LEFT JOIN Event_Solves s ON s.user_id = u.id
    WHERE u.role = 'team' AND u.disqualified_at IS NULL
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
async function mutationChallengeEnabled(): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
      "SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ?",
      [MUTATION_CHALLENGE_ID],
  );

  return rows.length > 0 && Number(rows[0].enabled) === 1;
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
        const [rows] = await pool.query<any[]>("SELECT id, username, display_name, password_hash, role, disqualified_at FROM Event_Users WHERE username = ? LIMIT 1", [username]);
        const account = rows[0];
        const valid = account ? await Bun.password.verify(password, account.password_hash).catch(() => false) : false;
        if (!valid) return json({ error: "Incorrect username or password." }, 401);
        if (account.role === "team" && account.disqualified_at) {
          return json({ error: "This team has been disqualified and can no longer access the event." }, 403);
        }

        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = sha256(rawToken);
        const userAgent = (req.headers.get("user-agent") || "unknown").slice(0, 512);
        const ipAddress = normalizedIp(ip);
        let tracked: Awaited<ReturnType<typeof getOrCreateTrackedPerson>> | null = null;
        let newSessionId = 0;
        let loginAccount: any = account;
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          // Re-check under the same team-row lock used by disqualification. This closes a login/DQ race.
          const [freshRows] = await conn.query<any[]>(`SELECT id, username, display_name, role, disqualified_at
            FROM Event_Users WHERE id = ? FOR UPDATE`, [account.id]);
          if (!freshRows.length) {
            await conn.rollback();
            return json({ error: "Incorrect username or password." }, 401);
          }
          loginAccount = freshRows[0];
          if (loginAccount.role === "team" && loginAccount.disqualified_at) {
            await conn.rollback();
            return json({ error: "This team has been disqualified and can no longer access the event." }, 403);
          }
          tracked = loginAccount.role === "team"
            ? await getOrCreateTrackedPerson(Number(loginAccount.id), ipAddress, userAgent, conn)
            : null;
          const [sessionResult]: any = await conn.query(`INSERT INTO Event_Sessions
            (user_id, token_hash, expires_at, ip_address, user_agent, tracked_person_id)
            VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), ?, ?, ?)`,
            [loginAccount.id, tokenHash, SESSION_DAYS, ipAddress, userAgent, tracked?.id ?? null]);
          newSessionId = Number(sessionResult.insertId);
          await conn.commit();
        } catch (error) {
          await conn.rollback();
          throw error;
        } finally {
          conn.release();
        }
        if (loginAccount.role === "team" && tracked) {
          await logActivity({
            teamId: Number(loginAccount.id), personId: tracked.id, sessionId: newSessionId, actorUserId: Number(loginAccount.id),
            eventType: tracked.wasAway ? "reconnect" : "login",
            details: tracked.wasAway ? `${tracked.label} reconnected from the previously tracked IP.` : `${tracked.label} logged in.`,
            ipAddress, userAgent,
          });
          if (tracked.isNew && tracked.hasPriorIp) {
            await logActivity({
              teamId: Number(loginAccount.id), personId: tracked.id, sessionId: newSessionId, actorUserId: Number(loginAccount.id),
              eventType: "new_ip_observed",
              details: `New IP ${ipAddress} observed for this team. This may be a returning person's IP change or another person; admin review required. No automatic action was taken.`,
              ipAddress, userAgent,
            });
          }
        }
        loginAttempts.delete(ip);
        const secure = url.protocol === "https:" ? "; Secure" : "";
        const cookie = `${SESSION_COOKIE}=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
        return json({ ok: true, user: { id: Number(loginAccount.id), username: loginAccount.username, displayName: loginAccount.display_name, role: loginAccount.role }, redirect: loginAccount.role === "admin" ? "/admin" : "/challenges" }, 200, { "Set-Cookie": cookie });
      }
      if (path === "/api/logout" && method === "POST") {
        const raw = cookieValue(req, SESSION_COOKIE);
        if (raw) {
          const [sessionRows] = await pool.query<any[]>(`SELECT s.id, s.user_id AS userId, s.tracked_person_id AS personId,
            s.ip_address AS ipAddress, s.user_agent AS userAgent, u.role FROM Event_Sessions s
            JOIN Event_Users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL LIMIT 1`, [sha256(raw)]);
          await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP(), disconnected_logged_at = COALESCE(disconnected_logged_at, UTC_TIMESTAMP()) WHERE token_hash = ? AND revoked_at IS NULL", [sha256(raw)]);
          if (sessionRows.length && sessionRows[0].role === "team" && sessionRows[0].personId) {
            const session = sessionRows[0];
            await logActivity({ teamId: Number(session.userId), personId: Number(session.personId), sessionId: Number(session.id),
              actorUserId: Number(session.userId), eventType: "logout", details: `Browser session ${session.id} logged out.`,
              ipAddress: String(session.ipAddress || "unknown"), userAgent: String(session.userAgent || "") });
          }
        }
        return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (path === "/api/me" && method === "GET") {
        const auth = await authenticated(req, true, requestIp(req, server));
        if (!auth) return json({ authenticated: false }, 401);
        return json({ authenticated: true, user: { id: auth.user.id, username: auth.user.username, displayName: auth.user.display_name, role: auth.user.role } });
      }
      // Mutation password history.
      // Public password history.
      if (path === "/api/mutation/history" && method === "GET") {
        if (!(await mutationChallengeEnabled())) {
          return json(
              { error: "This challenge is currently disabled." },
              403,
          );
        }

        return json({
          passwords: mutationHistory,
          count: mutationHistory.length,
          limit: MUTATION_HISTORY_LIMIT,
        });
      }

// Public mutation challenge and query endpoint.
      if (path === "/mutation" && method === "GET") {
        if (!(await mutationChallengeEnabled())) {
          return new Response(null, {
            status: 403,
            headers: { "Cache-Control": "no-store" },
          });
        }

        if (url.searchParams.has("pass")) {
          const suppliedPassword = url.searchParams.get("pass") ?? "";

          if (suppliedPassword !== currentMutationPassword) {
            return new Response(null, {
              status: 401,
              headers: { "Cache-Control": "no-store" },
            });
          }

          const challenge = await loadChallenge(MUTATION_CHALLENGE_ID);

          if (!challenge) {
            return new Response(null, {
              status: 500,
              headers: { "Cache-Control": "no-store" },
            });
          }

          return new Response(challenge.flag, {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        // Display the challenge page without requiring login.
        return new Response(
            Bun.file(resolve(PUBLIC_DIR, "mutation.html")),
            {
              headers: { "Cache-Control": "no-store" },
            },
        );
      }

      // Public display: local event standings and the first-place state for every challenge.
      if (path === "/api/tv" && method === "GET") {
        const [board, challenges, settingRows] = await Promise.all([
          leaderboard(),
          allChallenges(false),
          pool.query<any[]>("SELECT setting_value FROM Event_Settings WHERE setting_key = ?", ["tv_display_text"]),
        ]);
        const displayText = settingRows[0][0]?.setting_value ?? "ip";
        return json({ eventStartedAt: STARTED, updatedAt: new Date().toISOString(), leaderboard: board, challenges, displayText });
      }

      // Team/member routes.
      if (path === "/api/challenges" && method === "GET") {
        const auth = await requireUser(req, requestIp(req, server)); if (isResponse(auth)) return auth;
        const all = await allChallenges(true);
        const [solved] = await pool.query<any[]>("SELECT challenge_id, placement, points, solved_at FROM Event_Solves WHERE user_id = ?", [auth.user.id]);
        const solvedMap = new Map<number, any>(solved.map((item) => [Number(item.challenge_id), item]));
        await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
          eventType: "view_challenge_list", details: "Opened the challenge list.", ipAddress: auth.ipAddress, userAgent: auth.userAgent });
        return json({ challenges: all.map((item) => ({ ...item, data: undefined, file: undefined, solve: solvedMap.get(item.id) || null })) });
      }
      const challengeMatch = path.match(/^\/api\/challenges\/([1-6])$/);
      if (challengeMatch && method === "GET") {
        const auth = await requireUser(req, requestIp(req, server)); if (isResponse(auth)) return auth;
        const challenge = await loadChallenge(Number(challengeMatch[1]));
        if (!challenge) return json({ error: "Challenge not found." }, 404);
        const [state] = await pool.query<any[]>("SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ?", [challenge.id]);
        if (!state.length || !Number(state[0].enabled)) return json({ error: "This challenge is currently disabled." }, 403);
        const [solveRows] = await pool.query<any[]>("SELECT placement, points, solved_at FROM Event_Solves WHERE user_id = ? AND challenge_id = ?", [auth.user.id, challenge.id]);
        await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
          eventType: "view_challenge", details: `Opened Challenge ${challenge.id}: ${challenge.title}.`, ipAddress: auth.ipAddress, userAgent: auth.userAgent });
        return json({ challenge: { id: challenge.id, title: challenge.title, data: challenge.data, file: challenge.file }, solve: solveRows[0] || null });
      }
      const submitMatch = path.match(/^\/api\/challenges\/([1-6])\/submit$/);
      if (submitMatch && method === "POST") {
        const auth = await requireUser(req, requestIp(req, server)); if (isResponse(auth)) return auth;
        const rateKey = `${requestIp(req, server)}:${auth.tokenHash}`;
        const now = Date.now(); const rate = flagAttempts.get(rateKey);
        if (rate && rate.resetAt > now && rate.count >= 20) return json({ error: "Too many flag attempts. Wait one minute and try again." }, 429);
        if (!rate || rate.resetAt <= now) flagAttempts.set(rateKey, { count: 1, resetAt: now + 60_000 }); else rate.count++;
        const challengeId = Number(submitMatch[1]);
        const body = await readJson(req);
        const provided = String(body?.flag || "").trim();
        if (provided.length !== 8) {
          await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
            eventType: "flag_attempt_rejected", details: `Submitted a flag with invalid length for Challenge ${challengeId}.`, ipAddress: auth.ipAddress, userAgent: auth.userAgent });
          return json({ correct: false, error: "Flags must be 8 characters." }, 400);
        }
        const challenge = await loadChallenge(challengeId);
        if (!challenge) return json({ error: "Challenge not found." }, 404);
        const conn = await pool.getConnection();
        let placement = 0;
        let originalPlacement = 0;
        let points = 0;
        let alreadySolved = false;
        try {
          await conn.beginTransaction();
          const [teamRows] = await conn.query<any[]>("SELECT disqualified_at FROM Event_Users WHERE id = ? FOR UPDATE", [auth.user.id]);
          if (!teamRows.length || teamRows[0].disqualified_at) { await conn.rollback(); return json({ error: "This team has been disqualified and can no longer access the event." }, 403); }
          const [stateRows] = await conn.query<any[]>("SELECT enabled FROM Event_Challenge_State WHERE challenge_id = ? FOR UPDATE", [challengeId]);
          if (!stateRows.length || !Number(stateRows[0].enabled)) { await conn.rollback(); return json({ error: "This challenge is currently disabled." }, 403); }
          const [existing] = await conn.query<any[]>("SELECT placement, original_placement, points, solved_at FROM Event_Solves WHERE user_id = ? AND challenge_id = ?", [auth.user.id, challengeId]);
          if (provided !== challenge.flag) {
            await conn.rollback();
            await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
              eventType: "flag_attempt_incorrect", details: `Incorrect flag attempt for Challenge ${challengeId}: ${challenge.title}.`, ipAddress: auth.ipAddress, userAgent: auth.userAgent });
            return json({ correct: false, error: "Incorrect flag. Try again." }, 200);
          }
          if (existing.length) {
            await conn.rollback();
            placement = Number(existing[0].placement);
            originalPlacement = Number(existing[0].original_placement || existing[0].placement);
            points = Number(existing[0].points);
            alreadySolved = true;
          } else {
            const [countRows] = await conn.query<any[]>(`SELECT COALESCE(MAX(s.placement), 0) AS maxPlacement
              FROM Event_Solves s JOIN Event_Users u ON u.id = s.user_id
              WHERE s.challenge_id = ? AND u.role = 'team' AND u.disqualified_at IS NULL`, [challengeId]);
            placement = Number(countRows[0].maxPlacement || 0) + 1;
            const [originalCountRows] = await conn.query<any[]>("SELECT COALESCE(MAX(original_placement), 0) AS maxOriginalPlacement FROM Event_Solves WHERE challenge_id = ?", [challengeId]);
            originalPlacement = Number(originalCountRows[0].maxOriginalPlacement || 0) + 1;
            const [pointRows] = await conn.query<any[]>("SELECT points FROM Event_Challenge_Points WHERE challenge_id = ? AND placement <= ? ORDER BY placement DESC LIMIT 1", [challengeId, placement]);
            points = pointRows.length ? Number(pointRows[0].points) : 0;
            await conn.query("INSERT INTO Event_Solves (user_id, challenge_id, placement, original_placement, points) VALUES (?, ?, ?, ?, ?)", [auth.user.id, challengeId, placement, originalPlacement, points]);
            await conn.commit();
          }
        } catch (error) {
          await conn.rollback(); throw error;
        } finally { conn.release(); }
        await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
          eventType: alreadySolved ? "flag_already_captured" : "flag_captured",
          details: alreadySolved
            ? `Submitted a correct flag for Challenge ${challengeId}, which this team had already captured (current eligible place ${placement}, original capture place ${originalPlacement}, ${points} points).`
            : `Captured Challenge ${challengeId}: ${challenge.title} (current eligible place ${placement}, original capture place ${originalPlacement}, ${points} points).`,
          ipAddress: auth.ipAddress, userAgent: auth.userAgent });
        const message = placement === 1 ? "Correct! First place on this challenge." : "Correct! Flag captured.";
        return json({ correct: true, alreadySolved, placement, points, message });
      }
      if (path === "/api/leaderboard" && method === "GET") return json({ leaderboard: await leaderboard() });

      // Administrator-only API.
      if (path.startsWith("/api/admin/")) {
        const auth = await requireAdmin(req, requestIp(req, server)); if (isResponse(auth)) return auth;
        if (path === "/api/admin/overview" && method === "GET") {
          const [board, challenges, points, settingRows] = await Promise.all([
            leaderboard(),
            allChallenges(false),
            getPoints(),
            pool.query<any[]>("SELECT setting_value FROM Event_Settings WHERE setting_key = ?", ["tv_display_text"]),
          ]);
          const [sessionRows] = await pool.query<any[]>(`SELECT COUNT(*) AS total,
                                                                SUM(CASE WHEN revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() AND last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND) THEN 1 ELSE 0 END) AS online
                                                         FROM Event_Sessions`);
          const [teamRows] = await pool.query<any[]>(`SELECT u.id AS teamId, u.display_name AS team,
              u.disqualified_at AS disqualifiedAt, u.disqualification_reason AS disqualificationReason,
              CASE WHEN u.disqualified_at IS NULL THEN COALESCE(SUM(s.points), 0) ELSE 0 END AS points,
              CASE WHEN u.disqualified_at IS NULL THEN COUNT(s.id) ELSE 0 END AS solved,
              (SELECT COUNT(*) FROM Event_Tracked_People p WHERE p.team_id = u.id AND EXISTS (
                SELECT 1 FROM Event_Sessions ss WHERE ss.tracked_person_id = p.id AND ss.revoked_at IS NULL
                  AND ss.expires_at > UTC_TIMESTAMP() AND ss.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)
              )) AS onlinePeople
            FROM Event_Users u LEFT JOIN Event_Solves s ON s.user_id = u.id
            WHERE u.role = 'team' GROUP BY u.id, u.display_name, u.disqualified_at, u.disqualification_reason
            ORDER BY u.display_name ASC`);
          return json({
            leaderboard: board, challenges, points,
            teamStates: teamRows.map((r) => ({ ...r, teamId: Number(r.teamId), points: Number(r.points || 0), solved: Number(r.solved || 0), onlinePeople: Number(r.onlinePeople || 0), disqualified: Boolean(r.disqualifiedAt) })),
            tvDisplayText: settingRows[0][0]?.setting_value ?? "ip",
            sessions: { total: Number(sessionRows[0].total || 0), online: Number(sessionRows[0].online || 0) },
          });
        }
        if (path === "/api/admin/tv-display-text" && method === "POST") {
          const body = await readJson(req);
          if (typeof body?.text !== "string") return json({ error: "Enter the text to show on the TV board." }, 400);
          const text = body.text.trim();
          if (!text || text.length > 120) return json({ error: "TV text must be between 1 and 120 characters." }, 400);
          await pool.query(
              "INSERT INTO Event_Settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
              ["tv_display_text", text],
          );
          return json({ ok: true, text });
        }
        if (path === "/api/admin/sessions" && method === "GET") {
          const [rows] = await pool.query<any[]>(`SELECT s.id, s.user_id AS userId, u.username, u.display_name AS displayName, u.role,
            s.tracked_person_id AS trackedPersonId, p.label AS personLabel,
            s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
            s.ip_address AS ipAddress, s.user_agent AS userAgent,
            (s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND)) AS online
            FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
            LEFT JOIN Event_Tracked_People p ON p.id = s.tracked_person_id
            ORDER BY s.created_at DESC LIMIT 500`);
          return json({ sessions: rows.map((r) => ({ ...r, id: Number(r.id), userId: Number(r.userId), trackedPersonId: r.trackedPersonId ? Number(r.trackedPersonId) : null, online: Boolean(r.online) })) });
        }
        if (path === "/api/admin/people" && method === "GET") {
          await recordInactiveConnectionEvents();
          const [rows] = await pool.query<any[]>(`SELECT p.id, p.team_id AS teamId, u.display_name AS teamName,
              u.disqualified_at AS teamDisqualifiedAt, p.label, p.ip_address AS ipAddress,
              p.first_seen_at AS firstSeenAt, p.last_seen_at AS lastSeenAt, p.last_user_agent AS userAgent,
              COUNT(s.id) AS sessionCount,
              SUM(CASE WHEN s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
                AND s.last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 SECOND) THEN 1 ELSE 0 END) AS onlineSessions,
              TIMESTAMPDIFF(MINUTE, p.last_seen_at, UTC_TIMESTAMP()) AS disconnectedMinutes,
              ip_alert.newIpAt AS newIpAt
            FROM Event_Tracked_People p JOIN Event_Users u ON u.id = p.team_id
            LEFT JOIN Event_Sessions s ON s.tracked_person_id = p.id
            LEFT JOIN (
              SELECT person_id, MAX(created_at) AS newIpAt FROM Event_Activity_Logs
              WHERE event_type IN ('new_ip_observed', 'ip_change_detected') AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
              GROUP BY person_id
            ) ip_alert ON ip_alert.person_id = p.id
            WHERE u.role = 'team'
            GROUP BY p.id, p.team_id, u.display_name, u.disqualified_at, p.label, p.ip_address,
              p.first_seen_at, p.last_seen_at, p.last_user_agent, ip_alert.newIpAt
            ORDER BY onlineSessions DESC, p.last_seen_at DESC LIMIT 1000`);
          const people = rows.map((r) => {
            const onlineSessions = Number(r.onlineSessions || 0);
            const disconnectedMinutes = Number(r.disconnectedMinutes || 0);
            return { ...r, id: Number(r.id), teamId: Number(r.teamId), sessionCount: Number(r.sessionCount || 0),
              onlineSessions, disconnectedMinutes, online: onlineSessions > 0,
              longDisconnectWarning: onlineSessions === 0 && disconnectedMinutes >= 5,
              newIpAlert: Boolean(r.newIpAt), teamDisqualified: Boolean(r.teamDisqualifiedAt) };
          });
          return json({ people, longDisconnectThresholdMinutes: 5, onlineWindowSeconds: 90 });
        }
        const personLogsMatch = path.match(/^\/api\/admin\/people\/(\d+)\/logs$/);
        if (personLogsMatch && method === "GET") {
          const personId = Number(personLogsMatch[1]);
          const [personRows] = await pool.query<any[]>(`SELECT p.id, p.label, p.ip_address AS ipAddress,
              p.first_seen_at AS firstSeenAt, p.last_seen_at AS lastSeenAt,
              u.id AS teamId, u.display_name AS teamName
            FROM Event_Tracked_People p JOIN Event_Users u ON u.id = p.team_id WHERE p.id = ? LIMIT 1`, [personId]);
          if (!personRows.length) return json({ error: "Tracked person not found." }, 404);
          const [logs] = await pool.query<any[]>(`SELECT id, event_type AS eventType, details, ip_address AS ipAddress,
              user_agent AS userAgent, created_at AS createdAt, session_id AS sessionId
            FROM Event_Activity_Logs WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT 250`, [personId]);
          return json({ person: { ...personRows[0], id: Number(personRows[0].id), teamId: Number(personRows[0].teamId) },
            logs: logs.map((r) => ({ ...r, id: Number(r.id), sessionId: r.sessionId ? Number(r.sessionId) : null })) });
        }
        const disqualifyMatch = path.match(/^\/api\/admin\/teams\/(\d+)\/disqualify$/);
        if (disqualifyMatch && method === "POST") {
          const teamId = Number(disqualifyMatch[1]);
          if (!Number.isInteger(teamId) || teamId < 1) return json({ error: "Invalid team." }, 400);
          const body = await readJson(req);
          const reason = String(body?.reason || "Disqualified by administrator.").trim().slice(0, 500) || "Disqualified by administrator.";
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            const [teamRows] = await conn.query<any[]>("SELECT id, display_name AS team, role, disqualified_at AS disqualifiedAt FROM Event_Users WHERE id = ? FOR UPDATE", [teamId]);
            if (!teamRows.length || teamRows[0].role !== "team") { await conn.rollback(); return json({ error: "Team not found." }, 404); }
            if (teamRows[0].disqualifiedAt) { await conn.rollback(); return json({ error: "This team is already disqualified." }, 409); }
            // Serialize against flag submissions so current placements cannot race the re-ranking.
            const [challengeLocks] = await conn.query<any[]>("SELECT challenge_id FROM Event_Challenge_State ORDER BY challenge_id FOR UPDATE");
            const [scoreRows] = await conn.query<any[]>("SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS captures FROM Event_Solves WHERE user_id = ?", [teamId]);
            await conn.query("UPDATE Event_Users SET disqualified_at = UTC_TIMESTAMP(), disqualified_by = ?, disqualification_reason = ? WHERE id = ?", [auth.user.id, reason, teamId]);
            await conn.query("UPDATE Event_Sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()), disconnected_logged_at = COALESCE(disconnected_logged_at, UTC_TIMESTAMP()) WHERE user_id = ?", [teamId]);
            // Preserve the disqualified team's original capture order for audit, but remove its score.
            await conn.query("UPDATE Event_Solves SET points = 0 WHERE user_id = ?", [teamId]);
            const adminIp = normalizedIp(requestIp(req, server));
            const adminAgent = (req.headers.get("user-agent") || "unknown").slice(0, 512);
            const placementChanges: PlacementChange[] = [];
            for (const challengeLock of challengeLocks) {
              placementChanges.push(...await recalculateEligiblePlacements(conn, Number(challengeLock.challenge_id)));
            }
            // Record the automatic promotion/re-scoring both for the team and each tracked identity.
            for (const change of placementChanges) {
              const adjustmentDetails = `After ${teamRows[0].team} was disqualified, your Challenge ${change.challengeId} result was recalculated: eligible place ${change.previousPlacement} -> ${change.placement}, points ${change.previousPoints} -> ${change.points}. Original capture place remains ${change.originalPlacement}.`;
              await conn.query(`INSERT INTO Event_Activity_Logs
                (team_id, person_id, session_id, actor_user_id, event_type, details, ip_address, user_agent)
                VALUES (?, NULL, ?, ?, 'placement_reassigned', ?, ?, ?)`,
                [change.teamId, auth.sessionId, auth.user.id, adjustmentDetails, adminIp, adminAgent]);
              await conn.query(`INSERT INTO Event_Activity_Logs
                (team_id, person_id, session_id, actor_user_id, event_type, details, ip_address, user_agent)
                SELECT ?, p.id, ?, ?, 'placement_reassigned', ?, ?, ?
                FROM Event_Tracked_People p WHERE p.team_id = ?`,
                [change.teamId, auth.sessionId, auth.user.id, adjustmentDetails, adminIp, adminAgent, change.teamId]);
            }
            const disqualificationDetails = `${teamRows[0].team} was disqualified. ${Number(scoreRows[0].points || 0)} points and ${Number(scoreRows[0].captures || 0)} captures are excluded from standings/first-capture claims. ${placementChanges.length} eligible capture result(s) were re-ranked/re-scored. For each affected challenge, the earliest remaining eligible capture is first, or the challenge becomes unclaimed if none remain. Original capture order remains in the audit data. Reason: ${reason}`;
            await conn.query(`INSERT INTO Event_Activity_Logs
              (team_id, person_id, session_id, actor_user_id, event_type, details, ip_address, user_agent)
              VALUES (?, NULL, ?, ?, 'team_disqualified', ?, ?, ?)`, [teamId, auth.sessionId, auth.user.id, disqualificationDetails, adminIp, adminAgent]);
            await conn.query(`INSERT INTO Event_Activity_Logs
              (team_id, person_id, session_id, actor_user_id, event_type, details, ip_address, user_agent)
              SELECT ?, p.id, ?, ?, 'team_disqualified', ?, ?, ? FROM Event_Tracked_People p WHERE p.team_id = ?`,
              [teamId, auth.sessionId, auth.user.id, disqualificationDetails, adminIp, adminAgent, teamId]);
            await conn.commit();
            return json({ ok: true, team: teamRows[0].team, pointsRemoved: Number(scoreRows[0].points || 0), capturesExcluded: Number(scoreRows[0].captures || 0), placementsAdjusted: placementChanges.length });
          } catch (error) { await conn.rollback(); throw error; }
          finally { conn.release(); }
        }
        const revokeMatch = path.match(/^\/api\/admin\/sessions\/(\d+)\/revoke$/);
        if (revokeMatch && method === "POST") {
          const id = Number(revokeMatch[1]);
          const [sessionRows] = await pool.query<any[]>(`SELECT s.id, s.user_id AS userId, s.tracked_person_id AS personId,
            s.ip_address AS ipAddress, s.user_agent AS userAgent FROM Event_Sessions s WHERE s.id = ? LIMIT 1`, [id]);
          const [result]: any = await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP(), disconnected_logged_at = COALESCE(disconnected_logged_at, UTC_TIMESTAMP()) WHERE id = ? AND revoked_at IS NULL", [id]);
          if (Number(result.affectedRows || 0) > 0 && sessionRows.length && sessionRows[0].personId) {
            const session = sessionRows[0];
            await logActivity({ teamId: Number(session.userId), personId: Number(session.personId), sessionId: id,
              actorUserId: auth.user.id, eventType: "session_disconnected_by_admin", details: `Administrator disconnected browser session ${id}.`,
              ipAddress: String(session.ipAddress || "unknown"), userAgent: String(session.userAgent || "") });
          }
          return json({ ok: true, revoked: Number(result.affectedRows || 0) > 0 });
        }
        const revokeUserMatch = path.match(/^\/api\/admin\/users\/(\d+)\/revoke-sessions$/);
        if (revokeUserMatch && method === "POST") {
          const userId = Number(revokeUserMatch[1]);
          if (userId === auth.user.id) return json({ error: "Use logout instead of revoking your own admin sessions." }, 400);
          const [sessionRows] = await pool.query<any[]>(`SELECT id, tracked_person_id AS personId, ip_address AS ipAddress, user_agent AS userAgent
            FROM Event_Sessions WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
          const [result]: any = await pool.query("UPDATE Event_Sessions SET revoked_at = UTC_TIMESTAMP(), disconnected_logged_at = COALESCE(disconnected_logged_at, UTC_TIMESTAMP()) WHERE user_id = ? AND revoked_at IS NULL", [userId]);
          for (const session of sessionRows) {
            if (!session.personId) continue;
            await logActivity({ teamId: userId, personId: Number(session.personId), sessionId: Number(session.id),
              actorUserId: auth.user.id, eventType: "session_disconnected_by_admin", details: `Administrator revoked all team sessions (browser session ${session.id}).`,
              ipAddress: String(session.ipAddress || "unknown"), userAgent: String(session.userAgent || "") });
          }
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
              ) WHERE s.challenge_id = ? AND EXISTS (
                SELECT 1 FROM Event_Users u WHERE u.id = s.user_id AND u.disqualified_at IS NULL
              )`, [id]);
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
        const auth = await authenticated(req, true, requestIp(req, server));
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
        if (auth.user.role === "team" && auth.user.disqualified_at) return redirect("/login");
        if (auth.user.role === "team" && auth.personId) {
          await logActivity({ teamId: auth.user.id, personId: auth.personId, sessionId: auth.sessionId, actorUserId: auth.user.id,
            eventType: "download_challenge_file", details: `Downloaded challenge file ${decodedPath}.`, ipAddress: auth.ipAddress, userAgent: auth.userAgent });
        }
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
