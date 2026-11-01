/**
 * Session fixation defence (TD-015): issue a NEW session id when a user authenticates and
 * drop the pre-login session from the store. Uses @fastify/session >= 11 regenerate().
 */
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedSessionData {
  userId: string;
  username: string;
  isAdmin: boolean;
  displayName: string;
}

export async function establishAuthenticatedSession(
  request: FastifyRequest,
  data: AuthenticatedSessionData
): Promise<void> {
  const oldId = request.session.sessionId;
  await request.session.regenerate();
  // Best effort: invalidate the pre-login id so a fixated cookie can't be reused
  const store = (
    request as unknown as {
      sessionStore?: { destroy(id: string, cb: (err?: unknown) => void): void };
    }
  ).sessionStore;
  if (oldId && oldId !== request.session.sessionId && store) {
    await new Promise<void>(resolve => store.destroy(oldId, () => resolve()));
  }
  request.session.userId = data.userId;
  request.session.username = data.username;
  request.session.isAdmin = data.isAdmin;
  request.session.displayName = data.displayName;
  await request.session.save();
}
