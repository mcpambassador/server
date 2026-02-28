/**
 * @mcpambassador/core
 *
 * Core package exports: SPI interfaces, database layer, config loader, pipeline, providers, audit buffer.
 *
 * @see Architecture §4 AAA Pipeline Architecture
 * @see Architecture §5 Service Provider Interface (SPI)
 */

// Database layer (M1)
export * from './db/index.js';

// Schema types (M1)
export * from './schema/index.js';

// SPI interfaces (M3.1)
export * from './spi/index.js';

// Configuration loader with secrets resolution (M3.3, M3.4)
export * from './config/index.js';
export * from './config/schema.js';

// Provider registry (M3.5)
export * from './providers/index.js';

// Audit buffer (M3.7)
export * from './audit/index.js';

// Pipeline orchestrator (M3.2)
export * from './pipeline/index.js';
export type { PipelineToolInvocationRequest } from './pipeline/index.js';

// Utilities
export * from './utils/errors.js';
export * from './utils/logger.js';
