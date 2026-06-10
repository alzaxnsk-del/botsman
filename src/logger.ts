import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

/**
 * Structured NDJSON logger with size-based rotation. Deliberately dependency-free:
 * one process, one file, keep N rotated generations.
 */
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;

type Level = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private file: string | null = null;

  init(): void {
    fs.mkdirSync(paths.logsDir(), { recursive: true });
    this.file = path.join(paths.logsDir(), 'botsman.log');
  }

  private rotateIfNeeded(): void {
    if (!this.file) return;
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_BYTES) return;
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* file may not exist yet */
    }
  }

  log(level: Level, msg: string, extra?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, msg, ...extra };
    const line = JSON.stringify(entry);
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line);
    if (this.file) {
      this.rotateIfNeeded();
      try {
        fs.appendFileSync(this.file, line + '\n');
      } catch {
        /* disk issues must not crash the daemon */
      }
    }
  }

  debug(msg: string, extra?: Record<string, unknown>) { this.log('debug', msg, extra); }
  info(msg: string, extra?: Record<string, unknown>) { this.log('info', msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>) { this.log('warn', msg, extra); }
  error(msg: string, extra?: Record<string, unknown>) { this.log('error', msg, extra); }
}

export const logger = new Logger();
