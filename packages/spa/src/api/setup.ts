import { apiClient } from './client';
import type { AuthResponse } from './types';

export interface SetupStatus {
  needsSetup: boolean;
  serverVersion?: string;
}

export const setupApi = {
  async getStatus(): Promise<SetupStatus> {
    return apiClient.get<SetupStatus>('/v1/setup/status');
  },

  async createAdmin(data: {
    username: string;
    password: string;
    display_name: string;
    email?: string;
  }): Promise<AuthResponse> {
    return apiClient.post<AuthResponse>('/v1/setup/admin', data);
  },
};
