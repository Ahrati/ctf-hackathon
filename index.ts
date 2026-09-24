import index from './html/index.html';
import admin from './html/admin.html';
import challenges from './html/challenges.html';

const PORT = Number(process.env.PORT) || 3000;
const CTFD_URL = process.env.CTFD_URL || "http://localhost:8000";

const server = Bun.serve({
    port: PORT,
    routes: {
        "/": index,
        "/admin": admin,
        "/challenges": challenges,
        "/api/challenges": async () => {
            try {
                const response = await fetch(`${CTFD_URL}/api/v1/challenges`, {
                    method: "GET",
                    headers: {
                        "Authorization": "Token ctfd_e4c05117c877fba4937c436a1cb2e3d7d0108dcb981774944171ee05ae76caa5",
                        "Content-Type": "application/json"
                    }
                });

                const data = await response.json();
                return Response.json(data);
            } catch (error) {
                return new Response("Greška pri spajanju na CTFd", { status: 500 });
            }
        }
    },
    fetch() {
        return new Response("Stranica nije pronađena", { status: 404 });
    }
});

console.log(`Server sluša na ${server.url}`);

