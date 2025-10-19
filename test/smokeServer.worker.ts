const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/ok":
        return new Response("ok", { status: 200 });
      case "/redirect":
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/redirect-final`,
          },
        });
      case "/redirect-chain":
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/redirect`,
          },
        });
      case "/redirect-final":
        return new Response("redirected", {
          status: 200,
          headers: {
            "X-Redirected": "true",
          },
        });
      case "/echo": {
        const requestBody = await request.text();
        return Response.json({
          method: request.method,
          body: requestBody,
          headers: Object.fromEntries(request.headers),
        });
      }
      case "/slow":
        await Bun.sleep(800);
        return new Response("slow", { status: 200 });
      default:
        return new Response("not-found", { status: 404 });
    }
  },
});

postMessage({ type: "ready", port: server.port });

addEventListener("message", (event) => {
  if (event.data === "close") {
    server.stop(true);
    postMessage({ type: "closed" });
    close();
  }
});
