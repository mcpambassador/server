/**
 * Logger utility (pino wrapper)
 *
 * Structured JSON logging with same format as audit events.
 *
 * @see Architecture §11 Audit Deep Dive
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import pinoModule from 'pino';

// Handle both ESM and CJS module formats
const pino = (
  typeof pinoModule === 'function' ? pinoModule : (pinoModule as any).default
) as typeof import('pino').default;

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
