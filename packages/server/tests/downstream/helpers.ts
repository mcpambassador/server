import { randomUUID } from 'crypto'

export function makeMcpConfig(overrides: Partial<Record<string, any>> = {}) {
  const name = overrides.name ?? `mcp-${randomUUID().slice(0, 8)}`
  return {
    name,
    transport: overrides.transport ?? 'stdio',
    command: overrides.command ?? 'node ./mcp.js',
    env: overrides.env ?? {},
    url: overrides.url,
    headers: overrides.headers ?? {},
    cwd: overrides.cwd ?? process.cwd(),
    timeout_ms: overrides.timeout_ms ?? 30000,
  }
}

export const STDIO_SAFE_ENV = [
  'PATH',
  'HOME',
  'NODE_ENV',
  'LANG',
  'TZ',
  'TERM',
  'USER',
  'SHELL',
]

export function makeTool(name: string, description?: string) {
  return {
    name,
    description,
  }
}

export default {
  makeMcpConfig,
  makeTool,
}
