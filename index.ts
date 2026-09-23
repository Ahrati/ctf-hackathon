import index from './html/index.html'

const server = Bun.serve({
    port: 3000,
    routes: {
        //"/" : () => new Response('Helo!'),
        "/" : index,
    }
});

console.log(`Listening on: ${server.url}`);