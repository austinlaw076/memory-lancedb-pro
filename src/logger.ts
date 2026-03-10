/**
 * Simple File Logger for memory-lancedb-pro
 * Writes logs to a dedicated file for debugging
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".openclaw", "logs");
const LOG_FILE = join(LOG_DIR, "memory-lancedb-pro.log");

// Ensure log directory exists
async function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  async info(message: string, ...args: unknown[]) {
    await ensureLogDir();
    const logLine = `[${formatTimestamp()}] [INFO] ${message} ${args.length ? JSON.stringify(args) : ""}\n`;
    await appendFile(LOG_FILE, logLine).catch(() => {});
  },

  async warn(message: string, ...args: unknown[]) {
    await ensureLogDir();
    const logLine = `[${formatTimestamp()}] [WARN] ${message} ${args.length ? JSON.stringify(args) : ""}\n`;
    await appendFile(LOG_FILE, logLine).catch(() => {});
  },

  async error(message: string, error?: unknown) {
    await ensureLogDir();
    const errorMsg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    const logLine = `[${formatTimestamp()}] [ERROR] ${message}: ${errorMsg}\n${stack}\n`;
    await appendFile(LOG_FILE, logLine).catch(() => {});
  },

  async debug(message: string, ...args: unknown[]) {
    await ensureLogDir();
    const logLine = `[${formatTimestamp()}] [DEBUG] ${message} ${args.length ? JSON.stringify(args) : ""}\n`;
    await appendFile(LOG_FILE, logLine).catch(() => {});
  },

  getLogPath(): string {
    return LOG_FILE;
  }
};

export default logger;
