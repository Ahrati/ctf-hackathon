console.log("Pokrećem dummy Bun server...");

Bun.serve({
    port: 3000,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/") {
            try {
                const response = await fetch("http://localhost:8000/api/v1/challenges", {
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

        return new Response("Stranica nije pronađena", { status: 404 });
    }
});

console.log("Server sluša na http://localhost:3000");