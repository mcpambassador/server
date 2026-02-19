/**
 * MCP Validator Unit Tests
 *
 * Tests for the MCP configuration validation engine.
 *
 * @see M23.7: Tests
 */

import { describe, it, expect } from 'vitest';
import { validateMcpConfig } from '../../src/services/mcp-validator.js';
import type { McpCatalogEntry } from '@mcpambassador/core';

describe('MCP Validator', () => {
  const createMockEntry = (
    transport: 'stdio' | 'http' | 'sse',
    config: Record<string, unknown>
  ): McpCatalogEntry => ({
    mcp_id: 'test-id',
    name: 'test-mcp',
    display_name: 'Test MCP',
    description: 'Test',
    icon_url: null,
    transport_type: transport,
    config: JSON.stringify(config),
    isolation_mode: 'shared',
    requires_user_credentials: false,
    credential_schema: '{}',
    tool_catalog: '[]',
    tool_count: 0,
    status: 'draft',
    published_by: null,
    published_at: null,
    validation_status: 'pending',
    validation_result: '{}',
    last_validated_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  describe('stdio transport', () => {
    it('should validate valid stdio config', async () => {
      const entry = createMockEntry('stdio', {
        command: ['node', 'server.js'],
        env: { NODE_ENV: 'production' },
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject stdio without command', async () => {
      const entry = createMockEntry('stdio', {
        env: { NODE_ENV: 'production' },
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('stdio transport requires "command" array in config');
    });

    it('should reject stdio with non-array command', async () => {
      const entry = createMockEntry('stdio', {
        command: 'node server.js',
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject stdio with non-string command elements', async () => {
      const entry = createMockEntry('stdio', {
        command: ['node', 123, 'server.js'],
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('stdio command array must contain only strings');
    });
  });

  describe('http/sse transport', () => {
    it('should validate valid http config', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com/mcp',
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate valid sse config', async () => {
      const entry = createMockEntry('sse', {
        url: 'https://example.com/events',
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject http without url', async () => {
      const entry = createMockEntry('http', {
        timeout_ms: 5000,
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('http transport requires "url" string in config');
    });

    it('should reject invalid URL', async () => {
      const entry = createMockEntry('http', {
        url: 'not-a-valid-url',
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid URL'))).toBe(true);
    });
  });

  describe('env var validation', () => {
    it('should accept valid env var references', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
        api_key: '${API_KEY}',
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn about malformed env var references', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
        api_key: '${API KEY}', // space in var name
      });

      const result = await validateMcpConfig(entry);

      // Still valid, but should have warning
      expect(result.warnings.some((w) => w.includes('malformed'))).toBe(true);
    });

    it('should handle multiple env var references', async () => {
      const entry = createMockEntry('stdio', {
        command: ['node', 'server.js'],
        env: {
          API_KEY: '${API_KEY}',
          API_SECRET: '${API_SECRET}',
        },
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
    });
  });

  describe('credential schema validation', () => {
    it('should validate when credentials not required', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
      });
      entry.requires_user_credentials = false;

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
    });

    it('should validate valid JSON Schema', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
      });
      entry.requires_user_credentials = true;
      entry.credential_schema = JSON.stringify({
        type: 'object',
        properties: {
          api_key: { type: 'string' },
        },
        required: ['api_key'],
      });

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(true);
    });

    it('should reject invalid credential schema JSON', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
      });
      entry.requires_user_credentials = true;
      entry.credential_schema = 'not-valid-json{';

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid credential_schema JSON'))).toBe(true);
    });

    it('should warn about incomplete JSON Schema', async () => {
      const entry = createMockEntry('http', {
        url: 'https://example.com',
      });
      entry.requires_user_credentials = true;
      entry.credential_schema = JSON.stringify({
        // Missing type and properties
        description: 'Some schema',
      });

      const result = await validateMcpConfig(entry);

      // Valid (doesn't error), but should warn
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('missing'))).toBe(true);
    });
  });

  describe('invalid config JSON', () => {
    it('should reject unparseable config', async () => {
      const entry = createMockEntry('stdio', {});
      entry.config = 'not-valid-json{';

      const result = await validateMcpConfig(entry);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Invalid config JSON'))).toBe(true);
    });
  });
});
