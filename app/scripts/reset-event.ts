import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool, initDb } from "../db";

const rl = createInterface({ input, output });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

try {
  console.log("\nCTF EVENT RESET");
  console.log("This removes the previous event's solves/placements, browser sessions, tracked IP identities, activity logs, and team disqualification status.");
  console.log("It PRESERVES user accounts, challenge enable/disable settings, point schedules, and TV display preference.");
  console.log("A private JSON backup of the cleared event data is written before any database changes.");

  const confirmation = (await rl.question('Type "RESET EVENT" to continue: ')).trim();
  if (confirmation !== "RESET EVENT") {
    console.log("Cancelled; no changes made.");
    process.exitCode = 1;
  } else {
    await initDb();

    const conn = await pool.getConnection();
    let backupPath = "";
    try {
      await conn.beginTransaction();

      // Lock parent rows first, matching the app's team -> challenge update order.
      // This pauses normal login, solve, identity-tracking, and disqualification writes
      // while the backup snapshot is gathered and the reset transaction runs.
      await conn.query("SELECT id FROM Event_Users ORDER BY id FOR UPDATE");
      await conn.query("SELECT challenge_id FROM Event_Challenge_State ORDER BY challenge_id FOR UPDATE");
      await conn.query("SELECT id FROM Event_Tracked_People ORDER BY id FOR UPDATE");
      await conn.query("SELECT id FROM Event_Sessions ORDER BY id FOR UPDATE");
      await conn.query("SELECT id FROM Event_Solves ORDER BY id FOR UPDATE");
      await conn.query("SELECT id FROM Event_Activity_Logs ORDER BY id FOR UPDATE");

      // Keep a complete event-history snapshot, but never save password hashes or
      // session token hashes. The database retains all accounts and their credentials.
      const [solves] = await conn.query<any[]>("SELECT * FROM Event_Solves ORDER BY id");
      const [sessions] = await conn.query<any[]>(
        `SELECT id, user_id, tracked_person_id, created_at, last_seen_at, expires_at,
                revoked_at, disconnected_logged_at, ip_address, user_agent
         FROM Event_Sessions ORDER BY id`,
      );
      const [trackedPeople] = await conn.query<any[]>("SELECT * FROM Event_Tracked_People ORDER BY team_id, id");
      const [activityLogs] = await conn.query<any[]>("SELECT * FROM Event_Activity_Logs ORDER BY id");
      const [challengeState] = await conn.query<any[]>("SELECT * FROM Event_Challenge_State ORDER BY challenge_id");
      const [points] = await conn.query<any[]>("SELECT * FROM Event_Challenge_Points ORDER BY challenge_id, placement");
      const [settings] = await conn.query<any[]>("SELECT * FROM Event_Settings ORDER BY setting_key");
      const [accounts] = await conn.query<any[]>(
        `SELECT id, username, display_name, role, created_at, disqualified_at,
                disqualified_by, disqualification_reason
         FROM Event_Users ORDER BY id`,
      );
      const [teamStates] = await conn.query<any[]>(
        `SELECT id, display_name, disqualified_at, disqualified_by, disqualification_reason
         FROM Event_Users WHERE role = 'team' ORDER BY id`,
      );

      const backupDir = process.env.RESET_BACKUP_DIR || "/app/backups";
      await mkdir(backupDir, { recursive: true });
      backupPath = join(backupDir, `event-reset-backup-${stamp()}.json`);
      await writeFile(backupPath, JSON.stringify({
        backupVersion: 2,
        createdAt: new Date().toISOString(),
        purpose: "Pre-reset snapshot of event data removed by RESET EVENT.",
        securityNote: "Password hashes and session token hashes are intentionally omitted. IP addresses, user agents, solve history, and activity logs may be sensitive; keep this backup private.",
        clearedByReset: [
          "Event_Solves: all solves, points, current placements, and original capture placements",
          "Event_Sessions: all browser sessions (all existing login cookies become invalid)",
          "Event_Tracked_People: IP-based dummy identities, allowing labels to restart at Person 1",
          "Event_Activity_Logs: previous-event team/person/session activity and disqualification audit entries",
          "Event_Users team disqualification fields",
        ],
        preservedInDatabase: [
          "Event_Users accounts and credentials",
          "Event_Challenge_State enabled/disabled settings",
          "Event_Challenge_Points scoring schedules",
          "Event_Settings display and application preferences",
          "Challenge files and other project configuration",
        ],
        counts: {
          solves: solves.length,
          sessions: sessions.length,
          trackedPeople: trackedPeople.length,
          activityLogs: activityLogs.length,
          accounts: accounts.length,
          teams: teamStates.length,
        },
        solves,
        sessions,
        trackedPeople,
        activityLogs,
        challengeState,
        points,
        settings,
        accounts,
        teamStates,
      }, null, 2), { flag: "wx" });

      // Delete logs before tracked people because logs reference people with SET NULL.
      // Delete sessions as well as solves so no prior-event connections remain visible.
      await conn.query("DELETE FROM Event_Activity_Logs");
      await conn.query("DELETE FROM Event_Sessions");
      await conn.query("DELETE FROM Event_Solves");
      await conn.query("DELETE FROM Event_Tracked_People");
      await conn.query(
        "UPDATE Event_Users SET disqualified_at = NULL, disqualified_by = NULL, disqualification_reason = NULL WHERE role = 'team'",
      );

      await conn.commit();

      console.log("\nReset complete.");
      console.log(`Pre-reset backup: ${backupPath}`);
      console.log(`Archived ${solves.length} solves, ${sessions.length} sessions, ${trackedPeople.length} tracked IP identities, and ${activityLogs.length} activity-log entries.`);
      console.log("Local solves, score placements, and original capture records: cleared.");
      console.log("Browser sessions: deleted; users must sign in again.");
      console.log("Tracked IP identities and activity logs: cleared for a fresh event.");
      console.log("Team disqualification status: cleared.");
      console.log("Accounts, challenge availability, point schedules, and display preferences: preserved.");
      console.log("\nBefore opening the event, review challenge availability and scoring schedules in the admin panel.");
    } catch (error) {
      await conn.rollback();
      if (backupPath) console.error(`The database reset did not commit. A pre-reset backup may still exist at: ${backupPath}`);
      throw error;
    } finally {
      conn.release();
    }
  }
} catch (error: any) {
  console.error("Reset failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
