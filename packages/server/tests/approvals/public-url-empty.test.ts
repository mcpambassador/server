/**
 * Compose passes `PUBLIC_URL: ${PUBLIC_URL:-}`, i.e. "" when unset. That must count as unset so the
 * approval UI base URL falls back to https://<server>:<admin port> instead of an invalid "".
 */
import { describe, it, expect } from 'vitest';
import { resolveApprovalUiBaseUrl } from '../../src/services/approvals/base-url.js';
import { approvalUiBaseUrlProblem } from '../../src/services/approvals/gate.js';

describe('approval UI base URL', () => {
  it.each(['', '   ', undefined])('PUBLIC_URL=%j falls back to https://<server>:9443', v => {
    const base = resolveApprovalUiBaseUrl(v, 'ambassador.local', 9443);
    expect(base).toBe('https://ambassador.local:9443');
    expect(approvalUiBaseUrlProblem(base)).toBeNull();
  });

  it('uses localhost when no server name is configured', () => {
    const base = resolveApprovalUiBaseUrl('', undefined, 9443);
    expect(base).toBe('https://localhost:9443');
    expect(approvalUiBaseUrlProblem(base)).toBeNull();
  });

  it('a set PUBLIC_URL wins, trimmed, without trailing slashes', () => {
    expect(resolveApprovalUiBaseUrl(' https://amb.example.com// ', 'x', 9443)).toBe(
      'https://amb.example.com'
    );
  });

  it('a set but non-https PUBLIC_URL is still reported as a problem', () => {
    expect(
      approvalUiBaseUrlProblem(resolveApprovalUiBaseUrl('http://amb.example.com', 'x', 9443))
    ).not.toBeNull();
  });
});
