/**
 * Logger utility (pino wrapper)
 *
 * Structured JSON logging with same format as audit events.
 *
 * @see Architecture §11 Audit Deep Dive
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import pinoModule from 'pino';
import { REDACT_CENSOR, REDACT_PATHS, serializeErr } from './redact.js';

// Handle both ESM and CJS module formats
const pino = (
  typeof pinoModule === 'function' ? pinoModule : (pinoModule as any).default
) as typeof import('pino').default;

/** Build a logger with the project's redaction config. `destination` is for tests. */
export function createLogger(
  destination?: import('pino').DestinationStream
): import('pino').Logger {
  const options: import('pino').LoggerOptions = {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label: string) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // TD-026: never log credentials, whatever object a call site passes
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    serializers: { err: serializeErr, error: serializeErr },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();

export type Logger = typeof logger;
