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
  console.log("This clears ALL local challenge solves/placements and revokes every login session.");
  console.log("It PRESERVES user accounts, challenge enable/disable settings, and point schedules.");
  console.log("It does NOT reset CTFd submissions or CTFd's native scoreboard.\n");

  const confirmation = (await rl.question('Type "RESET EVENT" to continue: ')).trim();
  if (confirmation !== "RESET EVENT") {
    console.log("Cancelled; no changes made.");
    process.exitCode = 1;
  } else {
    await initDb();

    // Save a backup of the competition state before making any changes.
    const [solves] = await pool.query("SELECT * FROM Event_Solves ORDER BY id");
    const [sessions] = await pool.query(
      `SELECT id, user_id, created_at, last_seen_at, expires_at, revoked_at, ip_address, user_agent
       FROM Event_Sessions ORDER BY id`
    );
    const [challengeState] = await pool.query("SELECT * FROM Event_Challenge_State ORDER BY challenge_id");
    const [points] = await pool.query("SELECT * FROM Event_Challenge_Points ORDER BY challenge_id, placement");

    const backupDir = process.env.RESET_BACKUP_DIR || "/app/backups";
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, `event-reset-backup-${stamp()}.json`);
    await writeFile(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      note: "Pre-reset snapshot. Includes solves, session metadata, challenge state and point schedules. Does not include passwords, session token hashes, or CTFd data.",
      solves, sessions, challengeState, points,
    }, null, 2), { flag: "wx" });

    // A transaction ensures the two competition-state mutations succeed together.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM Event_Solves");
      await conn.query("UPDATE Event_Sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP())");
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    console.log("\nReset complete.");
    console.log(`Pre-reset backup: ${backupPath}`);
    console.log("Local solves and placements: cleared.");
    console.log("Existing browser sessions: revoked.");
    console.log("Accounts and challenge settings: preserved.");
    console.log("\nNext steps:");
    console.log("1. Remove test team accounts and create official team accounts if needed.");
    console.log("2. Reset CTFd separately if you use its native scoreboard/submissions.");
    console.log("3. Verify the TV leaderboard and submit one controlled test flag.");
  }
} catch (error: any) {
  console.error("Reset failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
