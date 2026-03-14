import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_DIR = join(homedir(), ".openclaw", "logs", "memory-lancedb-pro");

function ensureDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function serialize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

export class FileLogger {
  constructor(filename) {
    this.filename = filename;
  }

  get path() {
    ensureDir();
    return join(LOG_DIR, this.filename);
  }

  log(level, event, data = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, serialize(value)]),
      ),
    };

    try {
      appendFileSync(this.path, `${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // Logging must never break runtime behavior.
    }
  }

  info(event, data = {}) {
    this.log("info", event, data);
  }

  warn(event, data = {}) {
    this.log("warn", event, data);
  }

  error(event, data = {}) {
    this.log("error", event, data);
  }

  debug(event, data = {}) {
    this.log("debug", event, data);
  }

  getPath() {
    return this.path;
  }
}

export function createFileLogger(filename) {
  return new FileLogger(filename);
}
