/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach } from 'vitest';
import { StdioMcpConnection } from '../stdio-connection.js';
import { HttpMcpConnection } from '../http-connection.js';
import type { DownstreamMcpConfig } from '../types.js';

describe('Health Detail Methods', () => {
  describe('StdioMcpConnection.getHealthDetail()', () => {
    let connection: StdioMcpConnection;

    beforeEach(() => {
      const config: DownstreamMcpConfig = {
        name: 'test-stdio',
        id: 'test-stdio-id',
        transport: 'stdio',
        command: ['node', '--version'],
        enabled: true,
      };
      connection = new StdioMcpConnection(config);
    });

    it('returns health detail structure before start', () => {
      const detail = connection.getHealthDetail();

      expect(detail).toMatchObject({
        pid: null,
        pendingRequests: 0,
        uptime_ms: null,
        processExited: false,
        toolCount: 0,
      });
    });

    it('has correct return type structure', () => {
      const detail = connection.getHealthDetail();

      expect(detail).toHaveProperty('pid');
      expect(detail).toHaveProperty('pendingRequests');
      expect(detail).toHaveProperty('uptime_ms');
      expect(detail).toHaveProperty('processExited');
      expect(detail).toHaveProperty('toolCount');

      // Type checks
      expect(typeof detail.pendingRequests).toBe('number');
      expect(typeof detail.processExited).toBe('boolean');
      expect(typeof detail.toolCount).toBe('number');
    });
  });

  describe('HttpMcpConnection.getHealthDetail()', () => {
    let connection: HttpMcpConnection;

    beforeEach(() => {
      const config: DownstreamMcpConfig = {
        name: 'test-http',
        id: 'test-http-id',
        transport: 'http',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      };
      connection = new HttpMcpConnection(config);
    });

    it('returns health detail structure before start', () => {
      const detail = connection.getHealthDetail();

      expect(detail).toMatchObject({
        consecutiveFailures: 0,
        maxFailures: 3,
        templateUrl: 'http://localhost:3000/mcp',
        uptime_ms: null,
        toolCount: 0,
      });
    });

    it('has correct return type structure', () => {
      const detail = connection.getHealthDetail();

      expect(detail).toHaveProperty('consecutiveFailures');
      expect(detail).toHaveProperty('maxFailures');
      expect(detail).toHaveProperty('templateUrl');
      expect(detail).toHaveProperty('uptime_ms');
      expect(detail).toHaveProperty('toolCount');

      // Type checks
      expect(typeof detail.consecutiveFailures).toBe('number');
      expect(typeof detail.maxFailures).toBe('number');
      expect(typeof detail.toolCount).toBe('number');
      expect(detail.maxFailures).toBe(3);
    });

    it('exposes template URL not resolved URL', () => {
      const config: DownstreamMcpConfig = {
        name: 'test-http-env',
        id: 'test-http-env-id',
        transport: 'http',
        url: 'http://localhost:3000/api/${SECRET_TOKEN}',
        enabled: true,
      };
      const envConnection = new HttpMcpConnection(config);
      const detail = envConnection.getHealthDetail();

      // Should return template, not resolved (to avoid leaking credentials)
      expect(detail.templateUrl).toBe('http://localhost:3000/api/${SECRET_TOKEN}');
    });
  });
});
