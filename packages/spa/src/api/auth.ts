import { apiClient } from './client';
import type { AuthResponse } from './types';

export const authApi = {
  async login(username: string, password: string): Promise<AuthResponse> {
    return apiClient.post<AuthResponse>('/v1/auth/login', {
      username,
      password,
    });
  },

  async logout(): Promise<void> {
    return apiClient.post<void>('/v1/auth/logout');
  },

  async getSession(): Promise<AuthResponse | null> {
    try {
      return await apiClient.get<AuthResponse>('/v1/auth/session');
    } catch (error) {
      // 401 means no active session
      return null;
    }
  },
};
