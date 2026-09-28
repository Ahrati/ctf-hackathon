import index from './html/index.html'
import admin from './html/admin.html'
import challenges from './html/challenges.html'

const server = Bun.serve({
    port: 3000,
    routes: {
        //"/" : () => new Response('Helo!'),
        "/": index,
        "/admin": admin,
        "/challenges": challenges,
    },
    fetch(){
        return new Response("Not Found", { status: 404 });
    }
});

console.log(`Listening on: ${server.url}`);