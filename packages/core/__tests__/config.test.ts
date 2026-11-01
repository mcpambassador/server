/**
 * Config loader tests
 *
 * Tests ${ENV_VAR} and ${file:/path} resolution, credential detection, validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadConfig } from '../src/config/index.js';

describe('Config Loader', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ambassador-test-'));
    configPath = path.join(tempDir, 'config.yaml');
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should load valid configuration', async () => {
    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    key_prefix: "amb_sk_"

authorization:
  provider: local_rbac
  config:
    storage: sqlite

audit:
  provider: file
  on_failure: buffer
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/ambassador.db

downstream_mcps:
  - name: github
    transport: stdio
    command: ["npx", "-y", "@anthropic/github-mcp"]
`;

    await fs.writeFile(configPath, configYaml);
    const config = await loadConfig(configPath, { scrub_env_vars: false, enforcement: 'warn' });

    expect(config.server.port).toBe(8443);
    expect(config.authentication.provider).toBe('api_key');
    expect(config.database.type).toBe('sqlite');
    expect(config.downstream_mcps).toHaveLength(1);
  });

  it('should resolve ${ENV:VAR} references', async () => {
    process.env.TEST_TOKEN = 'secret-token-value';

    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    api_token: \${ENV:TEST_TOKEN}

authorization:
  provider: local_rbac
  config: {}

audit:
  provider: file
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/test.db

downstream_mcps: []
`;

    await fs.writeFile(configPath, configYaml);
    const config = await loadConfig(configPath, { scrub_env_vars: false });

    expect(config.authentication.config.api_token).toBe('secret-token-value');

    delete process.env.TEST_TOKEN;
  });

  it('should resolve ${file:/path} references', async () => {
    const secretFile = path.join(tempDir, 'secret.txt');
    await fs.writeFile(secretFile, '  github-token-123  \n', { mode: 0o600 });

    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    github_token: \${file:${secretFile}}

authorization:
  provider: local_rbac
  config: {}

audit:
  provider: file
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/test.db

downstream_mcps: []
`;

    await fs.writeFile(configPath, configYaml);
    const config = await loadConfig(configPath, { scrub_env_vars: false });

    expect(config.authentication.config.github_token).toBe('github-token-123');
  });

  it('should error on missing environment variable', async () => {
    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    api_key: \${ENV:MISSING_VAR}

authorization:
  provider: local_rbac
  config: {}

audit:
  provider: file
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/test.db

downstream_mcps: []
`;

    await fs.writeFile(configPath, configYaml);

    await expect(loadConfig(configPath, { scrub_env_vars: false })).rejects.toThrow(
      'Environment variable MISSING_VAR not found'
    );
  });

  it('should error on missing secret file', async () => {
    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    api_key: \${file:/nonexistent/secret.txt}

authorization:
  provider: local_rbac
  config: {}

audit:
  provider: file
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/test.db

downstream_mcps: []
`;

    await fs.writeFile(configPath, configYaml);

    await expect(loadConfig(configPath, { scrub_env_vars: false })).rejects.toThrow(
      'Cannot read secret file'
    );
  });

  it('should block literal secrets in block mode', async () => {
    const configYaml = `
server:
  host: 0.0.0.0
  port: 8443

authentication:
  provider: api_key
  config:
    api_key: literal-secret-value

authorization:
  provider: local_rbac
  config: {}

audit:
  provider: file
  config:
    path: /var/log/audit.jsonl

database:
  type: sqlite
  url: ./data/test.db

downstream_mcps: []
`;

    await fs.writeFile(configPath, configYaml);

    await expect(
      loadConfig(configPath, { enforcement: 'block', scrub_env_vars: false })
    ).rejects.toThrow('literal value');
  });

  it('should validate schema and reject invalid config', async () => {
    const configYaml = `
server:
  port: "invalid"

authentication:
  provider: api_key
  config: {}
`;

    await fs.writeFile(configPath, configYaml);

    await expect(loadConfig(configPath, { scrub_env_vars: false })).rejects.toThrow();
  });

  it('should not leak source text (inline secrets) from YAML syntax errors', async () => {
    const secret = 'amb_pk_FAKESECRET1234567890';
    await fs.writeFile(
      configPath,
      `server:\n  host: 0.0.0.0\nauthentication:\n  api_key: ${secret} : [broken\n  other: "unterminated\n`
    );
    let message = '';
    try {
      await loadConfig(configPath);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Config YAML invalid: [A-Z_]+/);
    expect(message).not.toContain(secret);
  });

  it('should not echo the value of an unresolved credential reference', async () => {
    await fs.writeFile(
      configPath,
      'authentication:\n  provider: api_key\n  config:\n    api_key: "${bogus-FAKESECRET}"\n'
    );
    await expect(loadConfig(configPath)).rejects.toSatisfy(
      (e: Error) => e.message.includes('api_key') && !e.message.includes('FAKESECRET')
    );
  });

  describe('env scrub (TD-027)', () => {
    const yamlText = `
server:
  host: 0.0.0.0
  port: 8443
authentication:
  provider: api_key
  config: {}
authorization:
  provider: local_rbac
  config: {}
audit:
  provider: file
  config: {}
database:
  type: sqlite
  url: ./data/test.db
downstream_mcps: []
`;
    const names = ['TD027_REGISTRY_TOKEN', 'TD027_OTHER_SECRET', 'TD027_PLAIN'];
    afterEach(() => names.forEach(n => delete process.env[n]));

    it('scrubs credential-looking env vars by default', async () => {
      process.env.TD027_REGISTRY_TOKEN = 'a';
      process.env.TD027_OTHER_SECRET = 'b';
      process.env.TD027_PLAIN = 'c';
      await fs.writeFile(configPath, yamlText);
      await loadConfig(configPath, { scrub_env_vars: true });
      expect(process.env.TD027_REGISTRY_TOKEN).toBeUndefined();
      expect(process.env.TD027_OTHER_SECRET).toBeUndefined();
      expect(process.env.TD027_PLAIN).toBe('c');
    });

    it('preserves only the named vars; still scrubs the rest', async () => {
      process.env.TD027_REGISTRY_TOKEN = 'a';
      process.env.TD027_OTHER_SECRET = 'b';
      await fs.writeFile(configPath, yamlText);
      await loadConfig(configPath, {
        scrub_env_vars: true,
        preserve_env_vars: ['TD027_REGISTRY_TOKEN'],
      });
      expect(process.env.TD027_REGISTRY_TOKEN).toBe('a');
      expect(process.env.TD027_OTHER_SECRET).toBeUndefined();
    });

    it('preserve matches exact names only, not substrings', async () => {
      process.env.TD027_OTHER_SECRET = 'b';
      await fs.writeFile(configPath, yamlText);
      await loadConfig(configPath, { scrub_env_vars: true, preserve_env_vars: ['TD027_OTHER'] });
      expect(process.env.TD027_OTHER_SECRET).toBeUndefined();
    });
  });
});
