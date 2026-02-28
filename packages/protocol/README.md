# @mcpambassador/protocol

Type-only package defining the API contract between Ambassador Client and Server.

## Overview

This package contains **zero runtime dependencies**. It exports only TypeScript types and constants that define the HTTP API, events, and data structures shared between client and server.

## Versioning

The protocol package follows **semantic versioning**:

- **Major version** bumps indicate breaking API changes (requires coordinated client + server releases)
- **Minor version** bumps indicate non-breaking additions (new optional fields, new event types)
- **Patch version** bumps indicate documentation or type clarification (no functional changes)

## Exports

| Export                                                            | Description                  |
| ----------------------------------------------------------------- | ---------------------------- |
| `RegistrationRequest` / `RegistrationResponse`                    | Client registration types    |
| `ToolCatalogResponse`                                             | Tool catalog shape           |
| `ToolInvocationRequest` / `ToolInvocationResponse`                | Tool call request/response   |
| `AuditEvent`                                                      | Audit event schema           |
| `ErrorResponse`                                                   | Standard error envelope      |
| `KillSwitchNotification`                                          | Kill switch event (Phase 2)  |
| `ClientStatus`, `AuthMethod`, `HostTool`, `EventType`, `Severity` | Shared enums                 |
| `API_VERSION`                                                     | API version constant         |
| `PaginationMetadata`, `ListResponse<T>`                           | Admin API response envelopes |

## Usage

```typescript
import type {
  RegistrationRequest,
  ToolCatalogResponse,
  AuditEvent,
  API_VERSION
} from '@mcpambassador/protocol';

// Client code
const request: RegistrationRequest = {
  friendly_name: 'my-vscode-client',
  host_tool: 'vscode'
};

// Server code
const catalog: ToolCatalogResponse = {
  tools: [...],
  api_version: API_VERSION,
  timestamp: new Date().toISOString()
};
```

## License

Apache License 2.0 -- see [LICENSE](../../LICENSE).
