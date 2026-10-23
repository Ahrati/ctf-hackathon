import mysql from "mysql2/promise";

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

        await conn.query(`CREATE TABLE IF NOT EXISTS Event_Challenge_State (
          challenge_id INT PRIMARY KEY,
          enabled TINYINT(1) NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

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
      if (attempt === retries) {
        console.error("Database initialization failed:", error?.message ?? error);
        throw error;
      }
      console.log(`Waiting for database (${attempt}/${retries}): ${error?.code ?? error?.message ?? error}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
