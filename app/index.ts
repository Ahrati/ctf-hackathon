import index from './html/index.html';
import admin from './html/admin.html';
import challenges from './html/challenges.html';
import { pool, initDb } from './db';

const PORT = Number(process.env.PORT) || 3000;
const CTFD_URL = process.env.CTFD_URL || "http://localhost:8000";
const CTFD_TOKEN = process.env.CTFD_TOKEN || "ctfd_c18dde2253a725851d6dfa97d16d496fe466a0086e969b643373d40d0e504e40";

// Pokretanje inicijalizacije baze
initDb().catch((err) => console.error("Greška pri spajanju na bazu:", err));

// Pomoćna funkcija za dohvat s CTFd API-ja
async function fetchCtfd(endpoint: string) {
    const response = await fetch(`${CTFD_URL}/api/v1/${endpoint}`, {
        method: "GET",
        headers: {
            "Authorization": `Token ${CTFD_TOKEN}`,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`CTFd API greška (${response.status}): ${errorText || response.statusText}`);
    }

    return await response.json();
}

const server = Bun.serve({
    port: PORT,
    routes: {
        // HTML stranice
        "/": index,
        "/admin": admin,
        "/challenges": challenges,

        // Test baze
        "/api/db": async () => {
            try {
                const [rows] = await pool.query("SELECT COUNT(*) as count FROM App_Users");
                return Response.json({ status: "ok", usersCount: (rows as any)[0] });
            } catch (error: any) {
                return Response.json({ status: "error", message: error.message }, { status: 500 });
            }
        },

        // CTFd API rute
        "/api/challenges": async () => {
            try {
                const data = await fetchCtfd("challenges");
                return Response.json(data);
            } catch (error: any) {
                return Response.json({ error: error.message }, { status: 500 });
            }
        },

        "/api/users": async () => {
            try {
                const data = await fetchCtfd("users");
                return Response.json(data);
            } catch (error: any) {
                return Response.json({ error: error.message }, { status: 500 });
            }
        },

        "/api/teams": async () => {
            try {
                const data = await fetchCtfd("teams");
                return Response.json(data);
            } catch (error: any) {
                return Response.json({ error: error.message }, { status: 500 });
            }
        },

        "/api/scoreboard": async () => {
            try {
                const data = await fetchCtfd("scoreboard");
                return Response.json(data);
            } catch (error: any) {
                return Response.json({ error: error.message }, { status: 500 });
            }
        }
    },
    fetch() {
        return new Response("Stranica nije pronađena", { status: 404 });
    }
});

console.log(`Server sluša na ${server.url}`);
