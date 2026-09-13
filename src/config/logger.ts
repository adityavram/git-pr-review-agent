/**
 * Logger — REAL
 *
 * Pino logger with pretty-printing in TTY (local dev), raw JSON in production.
 * No mocks.
 */
import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});