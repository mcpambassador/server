import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as argon2 from 'argon2';

import {
  initializeDatabase,
  runMigrations,
  seedDatabaseIfNeeded,
  closeDatabase,
  type DatabaseClient,
  type DatabaseConfig,
} from '@mcpambassador/core';

import {
  generateAdminKey,
  recoverAdminKey,
  rotateAdminKey,
  factoryResetAdminKey,
} from '../src/admin/keys.js';
import { registerClient } from '../src/registration.js';
import { rotateClientKey } from '../src/rotation.js';
import { ApiKeyAuthProvider } from '../src/provider.js';

describe('authn-apikey mutations (integration)', () => {
  let db: DatabaseClient;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amb-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    const config: DatabaseConfig = {
      type: 'sqlite',
      sqliteFilePath: dbPath,
      enableWAL: false,
      seedOnInit: true,
    };

    db = await initializeDatabase(config);
    await runMigrations(db);
    await seedDatabaseIfNeeded(db, config);
  });

  afterEach(async () => {
    await closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('generateAdminKey: inserts admin_keys and enforces single active key', async () => {
    const res = await generateAdminKey(db, tmpDir);
    expect(res).toHaveProperty('admin_key');
    expect(res).toHaveProperty('recovery_token');
    expect(res.admin_key.startsWith('amb_ak_')).toBe(true);
    expect(res.recovery_token.startsWith('amb_rt_')).toBe(true);

    const record = await db.query.admin_keys.findFirst({});
    expect(record).toBeDefined();
    expect(record!.is_active).toBe(true);
    expect(record!.rotated_at).toBeNull();
    expect(record!.created_at).toBeTruthy();

    // key_hash should verify
    const ok = await argon2.verify(record!.key_hash, res.admin_key);
    expect(ok).toBe(true);

    // second generation should throw (only one active admin key allowed)
    await expect(generateAdminKey(db, tmpDir)).rejects.toBeTruthy();
  });

  it('recoverAdminKey: updates key_hash and sets rotated_at preserving id', async () => {
    const initial = await generateAdminKey(db, tmpDir);
    const before = await db.query.admin_keys.findFirst({});
    expect(before).toBeDefined();
    const id = before!.id;
    const oldHash = before!.key_hash;

    const recovered = await recoverAdminKey(db, initial.recovery_token, '127.0.0.1');
    expect(recovered).toHaveProperty('admin_key');

    const after = await db.query.admin_keys.findFirst({});
    expect(after).toBeDefined();
    expect(after!.id).toBe(id);
    expect(after!.is_active).toBe(true);
    expect(after!.rotated_at).toBeTruthy();
    expect(after!.key_hash).not.toBe(oldHash);

    const verifiesNew = await argon2.verify(after!.key_hash, recovered.admin_key);
    expect(verifiesNew).toBe(true);
  });

  it('rotateAdminKey: changes key_hash and recovery_token_hash and sets rotated_at', async () => {
    const initial = await generateAdminKey(db, tmpDir);
    const before = await db.query.admin_keys.findFirst({});
    const oldKeyHash = before!.key_hash;
    const oldRecoveryHash = before!.recovery_token_hash;

    // Recovery token file is written with 0o400, make it writable for rotation
    await fs.chmod(path.join(tmpDir, '.recovery-token'), 0o600);
    const rotated = await rotateAdminKey(db, initial.admin_key, initial.recovery_token, tmpDir);
    expect(rotated).toHaveProperty('admin_key');
    expect(rotated).toHaveProperty('recovery_token');

    const after = await db.query.admin_keys.findFirst({});
    expect(after).toBeDefined();
    expect(after!.is_active).toBe(true);
    expect(after!.rotated_at).toBeTruthy();
    expect(after!.key_hash).not.toBe(oldKeyHash);
    expect(after!.recovery_token_hash).not.toBe(oldRecoveryHash);

    const verifiesNew = await argon2.verify(after!.key_hash, rotated.admin_key);
    expect(verifiesNew).toBe(true);
  });

  it('factoryResetAdminKey: deactivates old key and creates a new active key', async () => {
    const initial = await generateAdminKey(db, tmpDir);
    // ensure recovery token file exists
    const recoveryPath = path.join(tmpDir, '.recovery-token');
    const recoveryFile = await fs.readFile(recoveryPath, 'utf-8');
    expect(recoveryFile.trim()).toBe(initial.recovery_token);

    // Recovery token file is written with 0o400, make it writable for factory reset
    await fs.chmod(recoveryPath, 0o600);
    const result = await factoryResetAdminKey(db, tmpDir);
    expect(result).toHaveProperty('admin_key');
    expect(result).toHaveProperty('recovery_token');

    const all = await db.query.admin_keys.findMany({});
    // There should be at least one inactive and one active record
    const active = all.filter(r => r.is_active);
    const inactive = all.filter(r => !r.is_active);
    expect(active.length).toBeGreaterThan(0);
    expect(inactive.length).toBeGreaterThan(0);
  });

  it('registerClient: inserts client record with api_key_hash and active status', async () => {
    const res = await registerClient(
      db,
      { friendly_name: 'test-cli', host_tool: 'vscode' },
      '127.0.0.1'
    );
    expect(res).toHaveProperty('client_id');
    expect(res).toHaveProperty('api_key');

    const client = await db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, res.client_id),
    });
    expect(client).toBeDefined();
    expect(client!.status).toBe('active');
    expect(client!.api_key_hash).toBeTruthy();

    const ok = await argon2.verify(client!.api_key_hash!, res.api_key);
    expect(ok).toBe(true);

    const profile = await db.query.tool_profiles.findFirst({
      where: (p, { eq }) => eq(p.name, 'all-tools'),
    });
    expect(profile).toBeDefined();
    expect(client!.profile_id).toBe(profile!.profile_id);
  });

  it('rotateClientKey: rotates client api key and invalidates old key', async () => {
    const reg = await registerClient(
      db,
      { friendly_name: 'rot-client', host_tool: 'vscode' },
      '127.0.0.1'
    );
    const before = await db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, reg.client_id),
    });
    const oldHash = before!.api_key_hash!;

    const rotated = await rotateClientKey(db, reg.client_id, reg.api_key);
    expect(rotated).toHaveProperty('api_key');

    const after = await db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, reg.client_id),
    });
    expect(after).toBeDefined();
    expect(after!.client_id).toBe(reg.client_id);
    expect(after!.api_key_hash).not.toBe(oldHash);

    // old key should no longer verify
    const argon2mod = await import('argon2');
    const oldValid = await argon2mod.verify(after!.api_key_hash, reg.api_key).catch(() => false);
    expect(oldValid).toBe(false);
  });

  it('ApiKeyAuthProvider.authenticate: succeeds and updates last_seen_at', async () => {
    const reg = await registerClient(
      db,
      { friendly_name: 'auth-client', host_tool: 'vscode' },
      '127.0.0.1'
    );

    const provider = new ApiKeyAuthProvider(db);
    await provider.initialize({});

    const before = await db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, reg.client_id),
    });
    expect(before).toBeDefined();

    const goodReq = { headers: { 'x-api-key': reg.api_key, 'x-client-id': reg.client_id } } as any;
    const badReq = {
      headers: { 'x-api-key': 'amb_sk_invalid', 'x-client-id': reg.client_id },
    } as any;

    const good = await provider.authenticate(goodReq);
    expect(good.success).toBe(true);
    // wait for background update
    await new Promise(r => setTimeout(r, 150));
    const after = await db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, reg.client_id),
    });
    expect(after).toBeDefined();
    expect(new Date(after!.last_seen_at).getTime()).toBeGreaterThan(
      new Date(before!.last_seen_at).getTime()
    );

    const bad = await provider.authenticate(badReq);
    expect(bad.success).toBe(false);
  });
});
