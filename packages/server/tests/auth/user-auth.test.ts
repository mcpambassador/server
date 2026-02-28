/**
 * User Auth Service Tests
 *
 * Unit tests for user authentication and management service.
 *
 * @see M21.9: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  users,
  compatInsert,
  type DatabaseClient,
} from '@mcpambassador/core';
import {
  authenticateUser,
  createUser,
  updateUserPassword,
  getUserById,
  getUserByUsername,
} from '../../src/auth/user-auth.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('User Auth Service', () => {
  let db: DatabaseClient;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    db = await initializeDatabase({
      type: 'sqlite',
      sqliteFilePath: dbPath,
      seedOnInit: false,
    });

    await runMigrations(db);
  });

  afterAll(async () => {
    await closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createUser', () => {
    it('should create user with hashed password', async () => {
      const user = await createUser(db, {
        username: 'testuser1',
        password: 'password123',
        display_name: 'Test User 1',
        email: 'test1@example.com',
      });

      expect(user.user_id).toBeDefined();
      expect(user.username).toBe('testuser1');
      expect(user.display_name).toBe('Test User 1');
      expect(user.email).toBe('test1@example.com');
      expect(user.password_hash).toBeDefined();
      expect(user.password_hash).toMatch(/^\$argon2id\$/);
      expect(user.is_admin).toBe(false);
    });

    it('should create admin user', async () => {
      const user = await createUser(db, {
        username: 'admin1',
        password: 'adminpass',
        display_name: 'Admin User',
        is_admin: true,
      });

      expect(user.is_admin).toBe(true);
    });
  });

  describe('authenticateUser', () => {
    it('should authenticate with correct credentials', async () => {
      await createUser(db, {
        username: 'authtest1',
        password: 'correctpass',
        display_name: 'Auth Test 1',
      });

      const user = await authenticateUser(db, 'authtest1', 'correctpass');
      expect(user).not.toBeNull();
      expect(user?.username).toBe('authtest1');
    });

    it('should reject incorrect password', async () => {
      await createUser(db, {
        username: 'authtest2',
        password: 'correctpass',
        display_name: 'Auth Test 2',
      });

      const user = await authenticateUser(db, 'authtest2', 'wrongpass');
      expect(user).toBeNull();
    });

    it('should reject non-existent user', async () => {
      const user = await authenticateUser(db, 'nonexistent', 'anypass');
      expect(user).toBeNull();
    });

    it('should reject user with null password_hash', async () => {
      // Manually insert user with null password_hash
      const userId = 'test-no-pass-' + Date.now();
      await compatInsert(db, users).values({
        user_id: userId,
        username: 'nopwduser',
        display_name: 'No Password User',
        email: null,
        password_hash: null,
        is_admin: false,
        status: 'active',
        auth_source: 'preshared_key',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: null,
        vault_salt: null,
        metadata: '{}',
      });

      const user = await authenticateUser(db, 'nopwduser', 'anypass');
      expect(user).toBeNull();
    });
  });

  describe('updateUserPassword', () => {
    it('should update user password', async () => {
      const user = await createUser(db, {
        username: 'pwdchange1',
        password: 'oldpass',
        display_name: 'Password Change Test',
      });

      // Update password
      await updateUserPassword(db, user.user_id, 'newpass');

      // Old password should not work
      const authOld = await authenticateUser(db, 'pwdchange1', 'oldpass');
      expect(authOld).toBeNull();

      // New password should work
      const authNew = await authenticateUser(db, 'pwdchange1', 'newpass');
      expect(authNew).not.toBeNull();
      expect(authNew?.username).toBe('pwdchange1');
    });
  });

  describe('getUserById', () => {
    it('should retrieve user by ID', async () => {
      const created = await createUser(db, {
        username: 'getbyid1',
        password: 'pass123',
        display_name: 'Get By ID Test',
      });

      const fetched = await getUserById(db, created.user_id);
      expect(fetched).not.toBeNull();
      expect(fetched?.user_id).toBe(created.user_id);
      expect(fetched?.username).toBe('getbyid1');
    });

    it('should return null for non-existent ID', async () => {
      const fetched = await getUserById(db, 'non-existent-id');
      expect(fetched).toBeNull();
    });
  });

  describe('getUserByUsername', () => {
    it('should retrieve user by username', async () => {
      await createUser(db, {
        username: 'getbyusername1',
        password: 'pass123',
        display_name: 'Get By Username Test',
      });

      const fetched = await getUserByUsername(db, 'getbyusername1');
      expect(fetched).not.toBeNull();
      expect(fetched?.username).toBe('getbyusername1');
    });

    it('should return null for non-existent username', async () => {
      const fetched = await getUserByUsername(db, 'nonexistent123');
      expect(fetched).toBeNull();
    });
  });
});
