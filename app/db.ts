import mysql, { type PoolConnection } from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure the database.");
}
const databaseUrl = new URL(DATABASE_URL);
if (databaseUrl.protocol !== "mysql:" && databaseUrl.protocol !== "mariadb:") {
  throw new Error("DATABASE_URL must use the mysql:// or mariadb:// protocol.");
}
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
if (!databaseName) throw new Error("DATABASE_URL must include a database name.");

export const pool = mysql.createPool({
  host: databaseUrl.hostname,
  port: Number(databaseUrl.port || 3306),
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  database: databaseName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "Z",
  dateStrings: true,
});


async function ensureColumn(conn: PoolConnection, tableName: string, columnName: string, definition: string): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  if (!rows.length) await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensureIndex(conn: PoolConnection, tableName: string, indexName: string, definition: string): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName],
  );
  if (!rows.length) await conn.query(`ALTER TABLE ${tableName} ADD ${definition}`);
}

const defaultSchedules: Record<number, number[]> = {
  1: [100, 75, 50, 25, 10],
  2: [125, 90, 60, 30, 10],
  3: [150, 110, 75, 40, 15],
  4: [175, 130, 90, 45, 20],
  5: [200, 150, 100, 50, 25],
  6: [250, 180, 120, 60, 30],
};

export async function initDb(retries = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await pool.getConnection();
      try {
        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Users (
                                                                   id INT AUTO_INCREMENT PRIMARY KEY,
                                                                   username VARCHAR(191) NOT NULL UNIQUE,
          display_name VARCHAR(191) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role ENUM('admin','team') NOT NULL DEFAULT 'team',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Sessions (
                                                                      id BIGINT AUTO_INCREMENT PRIMARY KEY,
                                                                      user_id INT NOT NULL,
                                                                      token_hash CHAR(64) NOT NULL UNIQUE,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          revoked_at DATETIME NULL,
          ip_address VARCHAR(64) NOT NULL DEFAULT 'unknown',
          user_agent VARCHAR(512) NOT NULL DEFAULT '',
          INDEX idx_sessions_user (user_id),
          INDEX idx_sessions_last_seen (last_seen_at),
          CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES Event_Users(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

        // These columns are additive migrations, so existing installations keep their data.
        await ensureColumn(conn, "Event_Users", "disqualified_at", "DATETIME NULL");
        await ensureColumn(conn, "Event_Users", "disqualified_by", "INT NULL");
        await ensureColumn(conn, "Event_Users", "disqualification_reason", "VARCHAR(500) NULL");

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Tracked_People (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          team_id INT NOT NULL,
          ip_address VARCHAR(64) NOT NULL,
          label VARCHAR(80) NOT NULL,
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_user_agent VARCHAR(512) NOT NULL DEFAULT '',
          UNIQUE KEY uniq_tracked_team_ip (team_id, ip_address),
          UNIQUE KEY uniq_tracked_team_label (team_id, label),
          INDEX idx_tracked_team_last_seen (team_id, last_seen_at),
          CONSTRAINT fk_tracked_people_team FOREIGN KEY (team_id) REFERENCES Event_Users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await ensureColumn(conn, "Event_Sessions", "tracked_person_id", "BIGINT NULL");
        await ensureColumn(conn, "Event_Sessions", "disconnected_logged_at", "DATETIME NULL");
        await ensureIndex(conn, "Event_Sessions", "idx_sessions_tracked_person", "INDEX idx_sessions_tracked_person (tracked_person_id)");

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Activity_Logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          team_id INT NULL,
          person_id BIGINT NULL,
          session_id BIGINT NULL,
          actor_user_id INT NULL,
          event_type VARCHAR(80) NOT NULL,
          details TEXT NOT NULL,
          ip_address VARCHAR(64) NOT NULL DEFAULT 'unknown',
          user_agent VARCHAR(512) NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_activity_person_created (person_id, created_at),
          INDEX idx_activity_team_created (team_id, created_at),
          INDEX idx_activity_type_created (event_type, created_at),
          CONSTRAINT fk_activity_team FOREIGN KEY (team_id) REFERENCES Event_Users(id) ON DELETE SET NULL,
          CONSTRAINT fk_activity_person FOREIGN KEY (person_id) REFERENCES Event_Tracked_People(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

        // Backfill identities for sessions created before this tracking feature was installed.
        const [untrackedSessions] = await conn.query<any[]>(`SELECT s.id AS sessionId, s.user_id AS teamId,
          s.ip_address AS ipAddress, s.user_agent AS userAgent,
          COALESCE(s.created_at, s.last_seen_at, UTC_TIMESTAMP()) AS createdAt,
          COALESCE(s.last_seen_at, s.created_at, UTC_TIMESTAMP()) AS lastSeenAt
          FROM Event_Sessions s JOIN Event_Users u ON u.id = s.user_id
          WHERE s.tracked_person_id IS NULL AND u.role = 'team' ORDER BY s.user_id, s.created_at ASC`);
        for (const session of untrackedSessions) {
          const teamId = Number(session.teamId);
          const rawIpAddress = String(session.ipAddress || "unknown");
          const ipAddress = rawIpAddress.toLowerCase().startsWith("::ffff:") ? rawIpAddress.slice(7) : rawIpAddress;
          const [existingPerson] = await conn.query<any[]>(
            "SELECT id FROM Event_Tracked_People WHERE team_id = ? AND ip_address = ? LIMIT 1",
            [teamId, ipAddress],
          );
          let personId: number;
          if (existingPerson.length) {
            personId = Number(existingPerson[0].id);
            await conn.query(`UPDATE Event_Tracked_People SET
              first_seen_at = LEAST(first_seen_at, ?), last_seen_at = GREATEST(last_seen_at, ?),
              last_user_agent = CASE WHEN ? >= last_seen_at THEN ? ELSE last_user_agent END
              WHERE id = ?`, [session.createdAt, session.lastSeenAt, session.lastSeenAt, String(session.userAgent || ""), personId]);
          } else {
            const [countRows] = await conn.query<any[]>("SELECT COUNT(*) AS count FROM Event_Tracked_People WHERE team_id = ?", [teamId]);
            const label = `Person ${Number(countRows[0].count) + 1}`;
            const [insertResult]: any = await conn.query(`INSERT INTO Event_Tracked_People
              (team_id, ip_address, label, first_seen_at, last_seen_at, last_user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
              [teamId, ipAddress, label, session.createdAt, session.lastSeenAt, String(session.userAgent || "")]);
            personId = Number(insertResult.insertId);
          }
          await conn.query("UPDATE Event_Sessions SET tracked_person_id = ? WHERE id = ? AND tracked_person_id IS NULL", [personId, session.sessionId]);
        }

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Challenge_State (
                                                                             challenge_id INT PRIMARY KEY,
                                                                             enabled TINYINT(1) NOT NULL DEFAULT 1
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Settings (
                                                                      setting_key VARCHAR(100) PRIMARY KEY,
          setting_value VARCHAR(255) NOT NULL DEFAULT ''
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        await conn.query(
            "INSERT IGNORE INTO Event_Settings (setting_key, setting_value) VALUES (?, ?)",
            ["tv_display_text", "ip"],
        );

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Challenge_Points (
          id INT AUTO_INCREMENT PRIMARY KEY,
          challenge_id INT NOT NULL,
          placement INT NOT NULL,
          points INT NOT NULL DEFAULT 0,
          UNIQUE KEY uniq_challenge_place (challenge_id, placement),
          CONSTRAINT fk_points_challenge FOREIGN KEY (challenge_id) REFERENCES Event_Challenge_State(challenge_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Solves (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          challenge_id INT NOT NULL,
          solved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          placement INT NOT NULL,
          points INT NOT NULL DEFAULT 0,
          UNIQUE KEY uniq_user_challenge (user_id, challenge_id),
          INDEX idx_solves_challenge_placement (challenge_id, placement),
          CONSTRAINT fk_solves_user FOREIGN KEY (user_id) REFERENCES Event_Users(id) ON DELETE CASCADE,
          CONSTRAINT fk_solves_challenge FOREIGN KEY (challenge_id) REFERENCES Event_Challenge_State(challenge_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
        // Current placement can be recalculated when a higher-ranked team is disqualified.
        // Keep original_placement immutable so audit history still shows the capture order.
        await ensureColumn(conn, "Event_Solves", "original_placement", "INT NULL");
        const [missingOriginalPlacement] = await conn.query<any[]>(
          "SELECT id FROM Event_Solves WHERE original_placement IS NULL LIMIT 1",
        );
        if (missingOriginalPlacement.length) {
          // Backfill the immutable original order from solve timestamps, including disqualified teams.
          const [historicalSolves] = await conn.query<any[]>(
            "SELECT id, challenge_id FROM Event_Solves ORDER BY challenge_id ASC, solved_at ASC, id ASC",
          );
          const positions = new Map<number, number>();
          for (const solve of historicalSolves) {
            const challengeId = Number(solve.challenge_id);
            const originalPlacement = (positions.get(challengeId) || 0) + 1;
            positions.set(challengeId, originalPlacement);
            await conn.query("UPDATE Event_Solves SET original_placement = ? WHERE id = ?", [originalPlacement, solve.id]);
          }
        }

        // Seed state and placement schedules without overwriting administrator edits.
        for (let challengeId = 1; challengeId <= 6; challengeId++) {
          await conn.query(
              "INSERT IGNORE INTO Event_Challenge_State (challenge_id, enabled) VALUES (?, 1)",
              [challengeId],
          );
          const schedule = defaultSchedules[challengeId] ?? [];
          for (let i = 0; i < schedule.length; i++) {
            await conn.query(
                "INSERT IGNORE INTO Event_Challenge_Points (challenge_id, placement, points) VALUES (?, ?, ?)",
                [challengeId, i + 1, schedule[i]],
            );
          }
        }
      } finally {
        conn.release();
      }
      console.log("Database initialized.");
      return;
    } catch (error: any) {
      const code = String(error?.code ?? "");
      const message = String(error?.message ?? error);
      // Retry connection/startup failures, but fail immediately for SQL/schema/data
      // errors so the logs identify the real cause instead of calling it "waiting".
      const transientCodes = new Set([
        "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
        "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
        "ER_CON_COUNT_ERROR", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT",
      ]);
      if (!transientCodes.has(code) || attempt === retries) {
        console.error(`Database initialization failed${code ? ` (${code})` : ""}: ${message}`);
        if (error?.sql) console.error("Failed SQL statement:", String(error.sql).slice(0, 1000));
        throw error;
      }
      console.warn(`Database connection not ready (${attempt}/${retries})${code ? ` (${code})` : ""}: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
