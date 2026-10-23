import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pool, initDb } from "../db";

const [usernameArg, roleArg, ...nameArgs] = Bun.argv.slice(2);
const username = String(usernameArg || "").trim();
const role = String(roleArg || "team");
const displayName = nameArgs.join(" ").trim() || username;
if (!username || !["admin", "team"].includes(role) || username.length > 191 || displayName.length > 191) {
  console.error("Usage: bun run user:add -- <username> <admin|team> [display name]");
  process.exit(1);
}
const rl = createInterface({ input, output });
try {
  const password = await rl.question("Password (input will be visible in this terminal): ");
  if (password.length < 10) throw new Error("Use a password with at least 10 characters.");
  await initDb();
  const hash = await Bun.password.hash(password);
  await pool.query("INSERT INTO Event_Users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)", [username, displayName, hash, role]);
  console.log(`Created ${role} account '${username}'.`);
} catch (error: any) {
  console.error("Could not create account:", error?.code === "ER_DUP_ENTRY" ? "That username already exists." : error?.message || error);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
