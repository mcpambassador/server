import { apiClient, clearCsrfToken } from './client';
import type { AuthResponse } from './types';

export const authApi = {
  async login(username: string, password: string): Promise<AuthResponse> {
    // Clear any stale CSRF token before logging in — the session will rotate.
    clearCsrfToken();
    return apiClient.post<AuthResponse>('/v1/auth/login', {
      username,
      password,
    });
  },

  async logout(): Promise<void> {
    // Clear the CSRF token before logging out — the session is about to be
    // destroyed, so the cached token would be invalid for the next session.
    clearCsrfToken();
    return apiClient.post<void>('/v1/auth/logout');
  },

  async getSession(): Promise<AuthResponse | null> {
    try {
      return await apiClient.get<AuthResponse>('/v1/auth/session');
    } catch {
      // 401 means no active session
      return null;
    }
  },
};
