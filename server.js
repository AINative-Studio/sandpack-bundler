const fastify = require("fastify");
const fastifyStatic = require("fastify-static");
const path = require("path");

const PORT = +(process.env.PORT || "4587");

const app = fastify();

app.register(fastifyStatic, {
  root: path.join(__dirname, "dist"),
  prefix: "/",
  cacheControl: true,
  dotfiles: "deny",
  etag: true,
  immutable: true,
  maxAge: 31 * 24 * 60 * 60 * 1000,
});

// Fallback to index.html, it's a SPA
app.setNotFoundHandler((req, reply) => {
  return reply.sendFile("index.html", { cacheControl: false });
});

// Run the server!
// Bind explicitly to 0.0.0.0: Fastify v3's listen(port, cb) two-arg form
// defaults host to 'localhost' (127.0.0.1/::1 loopback only -- see
// fastify/lib/server.js normalizeListenArgs), which is unreachable from
// Railway's edge proxy even though the process itself comes up healthy.
// AINative fork notice (issue #1081, builder-ainative-studio): without
// this, every deploy behind a reverse proxy/container network (Railway,
// Docker, etc.) 502s on every request despite "Server is listening" in
// the logs and the instance showing RUNNING.
app.listen(PORT, "0.0.0.0", (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Server is now listening on ${address}
  console.log(`Server is listening on http://localhost:${PORT}`);
});
