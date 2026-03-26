/** `serve` command — start local HTTP server. */
import { startServer } from "../server/index.js";
import log from "../logger.js";

export async function runServe({ host = "127.0.0.1", port = 8080 } = {}) {
  const server = await startServer({ host, port });
  log.info(`Server running at http://${host}:${port}`);
  log.info("Press Ctrl+C to stop.");
  // Open browser if possible
  try {
    const { default: open } = await import("open").catch(() => ({ default: null }));
    if (open) open(`http://${host}:${port}`);
  } catch { /* optional */ }
  return server;
}
