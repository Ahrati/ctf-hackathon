import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool, initDb } from "../db";

const rl = createInterface({ input, output });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

let conn: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
let transactionStarted = false;
let backupPath = "";

try {
  console.log("\nWIPE ALL USERS AND ACCOUNT DATA");
  console.log("This permanently deletes EVERY Event_Users account, including all team and admin accounts.");
  console.log("It also clears user-linked solves/scores, sessions, tracked IP identities, and activity logs.");
  console.log("Challenge files, challenge enabled/disabled state, point schedules, and Event_Settings are preserved.");
  console.log("A private backup is written first. It contains password hashes so accounts can potentially be restored; protect it like a credential file.");
  console.log("Afterward, you must create a new admin account before starting the app.");

  await initDb();
  conn = await pool.getConnection();
  await conn.beginTransaction();
  transactionStarted = true;

  // Lock the account table and its user-owned records so no partial snapshot is taken.
  // Stop the app container before running this script, as documented in the README.
  await conn.query("SELECT id FROM Event_Users ORDER BY id FOR UPDATE");
  await conn.query("SELECT id FROM Event_Tracked_People ORDER BY id FOR UPDATE");
  await conn.query("SELECT id FROM Event_Sessions ORDER BY id FOR UPDATE");
  await conn.query("SELECT id FROM Event_Solves ORDER BY id FOR UPDATE");
  await conn.query("SELECT id FROM Event_Activity_Logs ORDER BY id FOR UPDATE");

  const [accounts] = await conn.query<any[]>("SELECT * FROM Event_Users ORDER BY id");
  const [sessions] = await conn.query<any[]>(
    `SELECT id, user_id, tracked_person_id, created_at, last_seen_at, expires_at,
            revoked_at, disconnected_logged_at, ip_address, user_agent
     FROM Event_Sessions ORDER BY id`,
  );
  const [solves] = await conn.query<any[]>("SELECT * FROM Event_Solves ORDER BY id");
  const [trackedPeople] = await conn.query<any[]>("SELECT * FROM Event_Tracked_People ORDER BY team_id, id");
  const [activityLogs] = await conn.query<any[]>("SELECT * FROM Event_Activity_Logs ORDER BY id");
  const [challengeState] = await conn.query<any[]>("SELECT * FROM Event_Challenge_State ORDER BY challenge_id");
  const [pointSchedules] = await conn.query<any[]>("SELECT * FROM Event_Challenge_Points ORDER BY challenge_id, placement");
  const [settings] = await conn.query<any[]>("SELECT * FROM Event_Settings ORDER BY setting_key");

  const admins = accounts.filter((account) => account.role === "admin").length;
  const teams = accounts.filter((account) => account.role === "team").length;
  console.log(`\nAccounts found: ${accounts.length} total (${admins} admin, ${teams} team).`);
  console.log(`User-linked records: ${solves.length} solves, ${sessions.length} sessions, ${trackedPeople.length} tracked identities, ${activityLogs.length} activity logs.`);

  const confirmation = (await rl.question('To continue, type exactly "WIPE ALL USERS": ')).trim();
  if (confirmation !== "WIPE ALL USERS") {
    console.log("Cancelled; no changes made.");
    process.exitCode = 1;
    await conn.rollback();
    transactionStarted = false;
  } else {
    const backupDir = process.env.RESET_BACKUP_DIR || "/app/backups";
    await mkdir(backupDir, { recursive: true });
    backupPath = join(backupDir, `users-wipe-backup-${stamp()}.json`);
    const backup = {
      backupVersion: 1,
      createdAt: new Date().toISOString(),
      purpose: "Pre-wipe snapshot of all user accounts and user-linked data removed by WIPE ALL USERS.",
      securityNote: "HIGHLY SENSITIVE: includes password hashes and user activity/IP data, but omits session token hashes. Restrict access and do not commit or share this file.",
      removed: [
        "All Event_Users accounts, including admins and teams, with password hashes for potential account recovery",
        "All Event_Sessions (metadata only; session token hashes are excluded and sessions cannot be restored as logged-in sessions)",
        "All Event_Solves, including awarded points and original/current capture placements",
        "All Event_Tracked_People IP identities",
        "All Event_Activity_Logs, including actor references and connection/disqualification audit data",
      ],
      preserved: [
        "Event_Challenge_State enabled/disabled state",
        "Event_Challenge_Points scoring schedules",
        "Event_Settings preferences",
        "Challenge CSV/files and other project configuration",
      ],
      counts: {
        accounts: accounts.length,
        admins,
        teams,
        sessions: sessions.length,
        solves: solves.length,
        trackedPeople: trackedPeople.length,
        activityLogs: activityLogs.length,
      },
      accounts,
      sessions,
      solves,
      trackedPeople,
      activityLogs,
      challengeState,
      pointSchedules,
      settings,
    };

    // Exclusive creation avoids silently overwriting a backup. Restrict permissions
    // because the snapshot includes password hashes and identifying activity data.
    await writeFile(backupPath, JSON.stringify(backup, null, 2), { flag: "wx", mode: 0o600 });
    await chmod(backupPath, 0o600);

    // Remove audit/session/solve records first to avoid stale actor/team references.
    // Challenge and application configuration deliberately remain untouched.
    await conn.query("DELETE FROM Event_Activity_Logs");
    await conn.query("DELETE FROM Event_Sessions");
    await conn.query("DELETE FROM Event_Solves");
    await conn.query("DELETE FROM Event_Tracked_People");
    await conn.query("DELETE FROM Event_Users");

    await conn.commit();
    transactionStarted = false;

    console.log("\nUser wipe complete.");
    console.log(`Private backup: ${backupPath}`);
    console.log(`Deleted ${accounts.length} accounts (${admins} admin, ${teams} team), ${solves.length} solves, ${sessions.length} sessions, ${trackedPeople.length} tracked identities, and ${activityLogs.length} activity-log entries.`);
    console.log("Challenge availability, scoring schedules, Event_Settings, challenge files, and project configuration were preserved.");
    console.log("NEXT STEP: create a new admin account before starting the app.");
  }
} catch (error: any) {
  if (conn && transactionStarted) {
    try {
      await conn.rollback();
    } catch {
      // Preserve the original error below.
    }
  }
  console.error("User wipe failed:", error?.message || error);
  if (backupPath) console.error(`A backup may remain at: ${backupPath}`);
  process.exitCode = 1;
} finally {
  if (conn) conn.release();
  rl.close();
  await pool.end();
}
