#!/usr/bin/env node

import { exec } from "child_process";
import path from "path";
import fs from "fs-extra";
import os from "os";

const viewerPath = path.resolve("./viewer/index.html");

if (!fs.existsSync(viewerPath)) {
  console.error("❌ Viewer not found! Please make sure viewer/index.html exists.");
  process.exit(1);
}

console.log("🚀 Starting AI Exporter Viewer...");

// Attempt to open the file directly (might have CORS issues for JSON fetch)
const platform = os.platform();
const command = platform === "darwin" ? `open "${viewerPath}"` : platform === "win32" ? `start "" "${viewerPath}"` : `xdg-open "${viewerPath}"`;

exec(command, (err) => {
  if (err) {
    console.error("❌ Failed to open viewer automatically:", err);
    console.log(`Please open this file manually: ${viewerPath}`);
  } else {
    console.log("✅ Viewer opened in your default browser.");
  }
});
