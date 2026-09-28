import index from './html/index.html'
import admin from './html/admin.html'
import challenges from './html/challenges.html'
import { parse } from "yaml";

interface Challenge{
  id: number;
  title: string;
  description?: string;
  points?: number;
  flag: string;
  filename: string;
  path: string;
}

interface User{
    username: string;
    password: string;
    role: string;
}

const server = Bun.serve({
    port: 3000,
    routes: {
        "/": index,
        "/admin": admin,
        "/challenges": challenges,
    },
    async fetch(req){
        const url = new URL(req.url);
        if (url.pathname === "/api/challenges" && req.method === "GET") {
            const yamlFile = Bun.file("./yml_files/challenges.yaml");
            const yamlText = await yamlFile.text();

            const challenges = parse(yamlText) as Challenge[];
            const publicChallenges = challenges.map(({ flag, ...publicData }) => publicData);
            
            return Response.json(publicChallenges);
        }
        if (url.pathname === "/api/users" && req.method === "GET") {
            const yamlFile = Bun.file("./yml_files/users.yaml");
            const yamlText = await yamlFile.text();

            const users = parse(yamlText);
            return Response.json(users);
        }
        return new Response("Not Found", { status: 404 });
    }
});

console.log(`Listening on: ${server.url}`);