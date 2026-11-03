import { describe, it, expect } from 'vitest';
import { compatTransaction, type DatabaseClient } from '@mcpambassador/core';

describe('compatTransaction', () => {
  it('a failing ROLLBACK does not mask the original error', async () => {
    const calls: string[] = [];
    const db = {
      $client: {
        prepare: (sql: string) => ({
          run: () => {
            calls.push(sql);
            if (sql === 'ROLLBACK') throw new Error('connection lost');
          },
        }),
      },
    } as unknown as DatabaseClient;

    await expect(
      compatTransaction(db, async () => {
        throw new Error('original failure');
      })
    ).rejects.toThrow('original failure');
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
