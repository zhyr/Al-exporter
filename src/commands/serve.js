/** `serve` command — start local HTTP server with graceful shutdown. */
import { startServer } from "../server/index.js";
import log from "../logger.js";

export async function runServe({ host = "127.0.0.1", port = 8080 } = {}) {
  const server = await startServer({ host, port });
  log.info(`Server running at http://${host}:${port}`);
  log.info("Press Ctrl+C to stop.");

  // Graceful shutdown on SIGINT / SIGTERM — SRE best practice
  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down…`);
    server.close(() => {
      log.info("Server stopped.");
      process.exit(0);
    });
    // Force-exit if connections don't drain within 5s
    setTimeout(() => {
      log.warn("Forced exit after shutdown timeout.");
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Open browser if possible
  try {
    const { default: open } = await import("open").catch(() => ({ default: null }));
    if (open) open(`http://${host}:${port}`);
  } catch { /* optional */ }
  return server;
}
