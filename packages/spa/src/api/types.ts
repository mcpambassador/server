export interface User {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
}

export interface ErrorResponse {
  error: string;
  message?: string;
}
