import { describe, it, expect } from 'vitest';

describe('MSW Setup', () => {
  it('should intercept API calls', async () => {
    const response = await fetch('/health');
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.status).toBe('ok');
  });

  it('should return mock auth data', async () => {
    const response = await fetch('/v1/auth/me');
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.username).toBe('admin');
  });
});
