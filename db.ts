import { Database } from "bun:sqlite"

export const db = new Database("app.db", {create: true});
db.run("PRAGMA journal_mode = WAL;"); //better performance for multiple reads TODO provjeri
//db.run("PRAGMA foreign_keys = ON;"); nes kao da sqlite po defaultu nema fks
db.run(
    `CREATE TABLE IF NOT EXISTS Users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    );`
);
db.run(
    `CREATE TABLE IF NOT EXISTS Sessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );`
);
db.run(
    `CREATE TABLE IF NOT EXISTS Challenges(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        points INTEGER,
        flag TEXT UNIQUE NOT NULL
    );`
);
db.run(
    `CREATE TABLE IF NOT EXISTS Challenge_files(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id INTEGER,
        filename TEXT UNIQUE NOT NULL,
        path TEXT UNIQUE NOT NULL
        FOREIGN KEY (challenge_id) REFERENCES Challenges(id) ON DELETE CASCADE
    );`
);

db.run("PRAGMA wal_checkpoint(TRUNCATE);"); //cleanup wal files
db.close();