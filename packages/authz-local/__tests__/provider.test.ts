/**
 * LocalRbacProvider Tests
 *
 * Tests authorization logic including:
 * - Deny-wins rule enforcement
 * - Glob matching
 * - Profile inheritance
 * - Cycle detection
 * - Default deny behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalRbacProvider, matchGlob } from '../src/index.js';
import type { SessionContext, AuthzRequest } from '@mcpambassador/core';
import {
  initializeDatabase,
  runMigrations,
  registerClient,
  createToolProfile,
  closeDatabase,
  type DatabaseClient,
} from '@mcpambassador/core';

describe('LocalRbacProvider', () => {
  let db: DatabaseClient;
  let provider: LocalRbacProvider;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: ':memory:', enableWAL: false });
    await runMigrations(db);

    provider = new LocalRbacProvider(db);
    await provider.initialize({ provider_type: 'authz', provider_id: 'local_rbac' });
  });

  afterEach(async () => {
    await provider.shutdown();
    await closeDatabase(db);
  });

  describe('authorize()', () => {
    it('should permit tool when allowed by profile', async () => {
      // Create profile allowing github tools
      const profile = await createToolProfile(db, {
        name: 'github-dev',
        description: 'GitHub development profile',
        allowed_tools: JSON.stringify(['github.*']),
        denied_tools: JSON.stringify([]),
      });

      // Create client with this profile
      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const request: AuthzRequest = {
        tool_name: 'github.search_code',
        tool_arguments: {},
      };

      const decision = await provider.authorize(session, request);

      expect(decision.decision).toBe('permit');
      expect(decision.reason).toContain('github.*');
      expect(decision.policy_id).toBe(profile.profile_id);
    });

    it('should deny tool when not in allowed list (default deny)', async () => {
      const profile = await createToolProfile(db, {
        name: 'limited',
        description: 'Limited profile',
        allowed_tools: JSON.stringify(['github.*']),
        denied_tools: JSON.stringify([]),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const request: AuthzRequest = {
        tool_name: 'slack.post_message',
        tool_arguments: {},
      };

      const decision = await provider.authorize(session, request);

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('default deny');
    });

    it('should enforce deny-wins rule', async () => {
      const profile = await createToolProfile(db, {
        name: 'deny-wins-test',
        description: 'Test deny-wins logic',
        allowed_tools: JSON.stringify(['*']), // Allow everything
        denied_tools: JSON.stringify(['github.delete_*']), // But deny deletions
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      // Test that read is allowed
      const readRequest: AuthzRequest = {
        tool_name: 'github.search_code',
        tool_arguments: {},
      };

      const readDecision = await provider.authorize(session, readRequest);
      expect(readDecision.decision).toBe('permit');

      // Test that delete is denied (deny-wins)
      const deleteRequest: AuthzRequest = {
        tool_name: 'github.delete_repository',
        tool_arguments: {},
      };

      const deleteDecision = await provider.authorize(session, deleteRequest);
      expect(deleteDecision.decision).toBe('deny');
      expect(deleteDecision.reason).toContain('denied');
      expect(deleteDecision.reason).toContain('github.delete_*');
    });

    it('should deny access for suspended client', async () => {
      const profile = await createToolProfile(db, {
        name: 'test-profile',
        description: 'Test profile',
        allowed_tools: JSON.stringify(['*']),
        denied_tools: JSON.stringify([]),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
        status: 'suspended',
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const request: AuthzRequest = {
        tool_name: 'github.search_code',
        tool_arguments: {},
      };

      const decision = await provider.authorize(session, request);

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('suspended');
      expect(decision.policy_id).toBe('system_lifecycle');
    });

    it('should deny access for revoked client', async () => {
      const profile = await createToolProfile(db, {
        name: 'test-profile',
        description: 'Test profile',
        allowed_tools: JSON.stringify(['*']),
        denied_tools: JSON.stringify([]),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
        status: 'revoked',
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const request: AuthzRequest = {
        tool_name: 'github.search_code',
        tool_arguments: {},
      };

      const decision = await provider.authorize(session, request);

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('revoked');
      expect(decision.policy_id).toBe('system_lifecycle');
    });
  });

  describe('listAuthorizedTools()', () => {
    it('should return only authorized tools', async () => {
      const profile = await createToolProfile(db, {
        name: 'github-only',
        description: 'GitHub only',
        allowed_tools: JSON.stringify(['github.*']),
        denied_tools: JSON.stringify([]),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const allTools = [
        { name: 'github.search_code', description: 'Search code', input_schema: {} },
        { name: 'github.create_issue', description: 'Create issue', input_schema: {} },
        { name: 'slack.post_message', description: 'Post message', input_schema: {} },
        { name: 'jira.create_ticket', description: 'Create ticket', input_schema: {} },
      ];

      const authorizedTools = await provider.listAuthorizedTools(session, allTools);

      expect(authorizedTools).toHaveLength(2);
      expect(authorizedTools.map(t => t.name)).toEqual([
        'github.search_code',
        'github.create_issue',
      ]);
    });

    it('should filter out denied tools from authorized list', async () => {
      const profile = await createToolProfile(db, {
        name: 'github-no-delete',
        description: 'GitHub without delete',
        allowed_tools: JSON.stringify(['github.*']),
        denied_tools: JSON.stringify(['github.delete_*']),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const allTools = [
        { name: 'github.search_code', description: 'Search code', input_schema: {} },
        { name: 'github.delete_repository', description: 'Delete repo', input_schema: {} },
        { name: 'github.delete_issue', description: 'Delete issue', input_schema: {} },
      ];

      const authorizedTools = await provider.listAuthorizedTools(session, allTools);

      expect(authorizedTools).toHaveLength(1);
      expect(authorizedTools[0].name).toBe('github.search_code');
    });

    it('should return empty array for suspended client', async () => {
      const profile = await createToolProfile(db, {
        name: 'test-profile',
        description: 'Test profile',
        allowed_tools: JSON.stringify(['*']),
        denied_tools: JSON.stringify([]),
      });

      const client = await registerClient(db, {
        friendly_name: 'test-client',
        host_tool: 'vscode',
        auth_method: 'api_key',
        profile_id: profile.profile_id,
        status: 'suspended',
      });

      const session: SessionContext = {
        session_id: 'session-123',
        client_id: client.client_id,
        auth_method: 'api_key',
        groups: [],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      const allTools = [
        { name: 'github.search_code', description: 'Search code', input_schema: {} },
      ];

      const authorizedTools = await provider.listAuthorizedTools(session, allTools);

      expect(authorizedTools).toHaveLength(0);
    });
  });
});

describe('matchGlob()', () => {
  it('should match wildcard * to everything', () => {
    expect(matchGlob('*', 'github.search_code')).toBe(true);
    expect(matchGlob('*', 'slack.post_message')).toBe(true);
    expect(matchGlob('*', 'anything.at.all')).toBe(true);
  });

  it('should match exact string when no wildcard', () => {
    expect(matchGlob('github.search_code', 'github.search_code')).toBe(true);
    expect(matchGlob('github.search_code', 'github.create_issue')).toBe(false);
  });

  it('should match prefix wildcard', () => {
    expect(matchGlob('github.*', 'github.search_code')).toBe(true);
    expect(matchGlob('github.*', 'github.create_issue')).toBe(true);
    expect(matchGlob('github.*', 'gitlab.search_code')).toBe(false);
  });

  it('should match suffix wildcard', () => {
    expect(matchGlob('*.search_code', 'github.search_code')).toBe(true);
    expect(matchGlob('*.search_code', 'gitlab.search_code')).toBe(true);
    expect(matchGlob('*.search_code', 'github.create_issue')).toBe(false);
  });

  it('should match middle wildcard', () => {
    expect(matchGlob('github.*.code', 'github.search.code')).toBe(true);
    expect(matchGlob('github.*.code', 'github.find.code')).toBe(true);
    expect(matchGlob('github.*.code', 'github.search.issues')).toBe(false);
  });

  it('should handle multiple wildcards', () => {
    expect(matchGlob('github.*.search_*', 'github.repo.search_code')).toBe(true);
    expect(matchGlob('github.*.search_*', 'github.org.search_repos')).toBe(true);
    expect(matchGlob('github.*.search_*', 'github.create_issue')).toBe(false);
  });

  it('should escape regex special characters', () => {
    expect(matchGlob('api+v1.users', 'api+v1.users')).toBe(true);
    expect(matchGlob('api.users?', 'api.users?')).toBe(true);
    expect(matchGlob('api[v1].users', 'api[v1].users')).toBe(true);
  });
});
