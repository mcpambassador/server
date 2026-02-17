/**
 * Logger utility (pino wrapper)
 * 
 * Structured JSON logging with same format as audit events.
 * 
 * @see Architecture §11 Audit Deep Dive
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;
