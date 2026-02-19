/**
 * Auth Request Schemas
 *
 * Zod validation schemas for authentication and user management endpoints.
 *
 * @see M21.5: Zod Request Schemas
 */

import { z } from 'zod';

/**
 * Login request schema
 */
export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginRequest = z.infer<typeof loginSchema>;

/**
 * Create user request schema
 */
export const createUserSchema = z.object({
  username: z.string().min(1, 'Username is required').max(255),
  password: z.string().min(1, 'Password is required').max(128),
  display_name: z.string().min(1, 'Display name is required').max(255),
  email: z.string().email().optional(),
  is_admin: z.boolean().optional(),
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;

/**
 * Update user request schema
 */
export const updateUserSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  email: z.string().email().nullable().optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  is_admin: z.boolean().optional(),
});

export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

/**
 * Change password request schema
 */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z.string().min(1, 'New password is required').max(128),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/**
 * User params schema (route parameter)
 */
export const userParamsSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
});

export type UserParams = z.infer<typeof userParamsSchema>;

/**
 * List users query schema
 */
export const listUsersQuerySchema = z.object({
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * Reset password request schema (admin only)
 */
export const resetPasswordSchema = z.object({
  new_password: z.string().min(1, 'New password is required').max(128),
});

export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
