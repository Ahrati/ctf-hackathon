import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL || "mysql://ctfd:ctfd_password@localhost:3306/ctfd";

export const pool = mysql.createPool({
    uri: DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

export async function initDb(retries = 15, delayMs = 2000): Promise<void> {
    while (retries > 0) {
        try {
            const connection = await pool.getConnection();
            console.log("💾 Uspješno spojen na MariaDB bazu podataka!");

            // Tablice za aplikaciju
            await connection.query(`
                CREATE TABLE IF NOT EXISTS App_Users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(191) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(50) NOT NULL DEFAULT 'user'
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `);

            await connection.query(`
                CREATE TABLE IF NOT EXISTS App_Sessions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT,
                    token VARCHAR(191) UNIQUE NOT NULL,
                    expires_at DATETIME,
                    FOREIGN KEY (user_id) REFERENCES App_Users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `);

            await connection.query(`
                CREATE TABLE IF NOT EXISTS App_Challenges (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(191) UNIQUE NOT NULL,
                    description TEXT NOT NULL,
                    points INT DEFAULT 0,
                    flag VARCHAR(191) NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `);

            await connection.query(`
                CREATE TABLE IF NOT EXISTS App_Challenge_files (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    challenge_id INT,
                    filename VARCHAR(191) NOT NULL,
                    path VARCHAR(255) NOT NULL,
                    FOREIGN KEY (challenge_id) REFERENCES App_Challenges(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `);

            connection.release();
            console.log("Tablice za aplikaciju su uspješno inicijalizirane!");
            return;
        } catch (error: any) {
            retries--;
            console.log(`⏳ Čekam MariaDB bazu... (${retries} pokušaja preostalo). Info: ${error.code || error.message}`);
            if (retries === 0) {
                console.error("❌ Nije uspjelo spajanje na MariaDB.");
                return;
            }
            await new Promise((res) => setTimeout(res, delayMs));
        }
    }
}