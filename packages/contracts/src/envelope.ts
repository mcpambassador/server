import { z } from 'zod';

// Success response envelope
export const successEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    ok: z.literal(true),
    data: dataSchema,
  });

// Paginated success response envelope
export const paginatedEnvelopeSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    ok: z.literal(true),
    data: z.array(itemSchema),
    pagination: z.object({
      has_more: z.boolean(),
      total_count: z.number().int().nonnegative(),
      next_cursor: z.string().nullable().optional(),
    }),
  });

// Error response envelope
export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.unknown()).optional(),
  }),
});

// Discriminated union for any response
export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion('ok', [successEnvelopeSchema(dataSchema), errorEnvelopeSchema]);

// TypeScript types
export type SuccessEnvelope<T> = { ok: true; data: T };
export type PaginatedEnvelope<T> = {
  ok: true;
  data: T[];
  pagination: { has_more: boolean; total_count: number; next_cursor?: string | null };
};
export type ErrorEnvelope = {
  ok: false;
  error: { code: string; message: string; details?: unknown[] };
};
export type ApiResponse<T> = SuccessEnvelope<T> | ErrorEnvelope;
