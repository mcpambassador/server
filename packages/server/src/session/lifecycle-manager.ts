/**
 * Session Lifecycle Manager (M15)
 *
 * Implements state machine transitions per ADR-011 §3:
 * - active → idle: All connections stale > idle_timeout
 * - idle → spinning_down: Idle for > spindown_delay
 * - spinning_down → suspended: Immediate (MCP termination stub)
 * - ANY → expired: TTL exceeded (NOW > expires_at)
 *
 * Periodic tasks:
 * - evaluateSessions(): Check state transitions every evaluation interval
 * - sweepExpiredSessions(): Delete tombstones every sweep interval
 *
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 * @see SEC-V2-009 TTL Hard Max (24h)
 */

import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import {
  user_sessions,
  session_connections,
  compatUpdate,
  compatDelete,
  logger,
} from '@mcpambassador/core';
import type { UserMcpPool } from '../downstream/index.js';

export interface SessionLifecycleConfig {
  /** How often to evaluate session state transitions (ms) */
  evaluationIntervalMs: number;
  /** How often to sweep expired sessions (ms) */
  sweepIntervalMs: number;
  /** Hard maximum session TTL in seconds (86400 = 24h) — SEC-V2-009 */
  ttlHardMaxSeconds: number;
}

export class SessionLifecycleManager {
  private evaluationTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private userPool?: UserMcpPool; // M17: Per-user MCP pool for lifecycle management

  constructor(
    private db: DatabaseClient,
    private audit: AuditProvider,
    private config: SessionLifecycleConfig,
    userPool?: UserMcpPool
  ) {
    this.userPool = userPool;
  }

  /**
   * Start periodic lifecycle evaluation and sweep
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[SessionLifecycle] Manager already running');
      return;
    }

    this.isRunning = true;
    logger.info(
      `[SessionLifecycle] Starting manager (eval: ${this.config.evaluationIntervalMs}ms, sweep: ${this.config.sweepIntervalMs}ms)`
    );

    // Start evaluation timer
    this.evaluationTimer = setInterval(() => {
      this.evaluateSessions().catch(err => {
        logger.error({ err }, '[SessionLifecycle] Evaluation error');
      });
    }, this.config.evaluationIntervalMs);

    // Start sweep timer
    this.sweepTimer = setInterval(() => {
      this.sweepExpiredSessions().catch(err => {
        logger.error({ err }, '[SessionLifecycle] Sweep error');
      });
    }, this.config.sweepIntervalMs);

    // Run initial evaluation immediately
    this.evaluateSessions().catch(err => {
      logger.error({ err }, '[SessionLifecycle] Initial evaluation error');
    });
  }

  /**
   * Stop periodic lifecycle evaluation and sweep
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('[SessionLifecycle] Stopping manager');
    this.isRunning = false;

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Evaluate all sessions for state transitions
   *
   * Transition logic:
   * 1. Check for TTL expiry first (overrides all other states)
   * 2. active → idle: All connections stale > idle_timeout
   * 3. idle → spinning_down: Idle for > spindown_delay
   * 4. spinning_down → suspended: Immediate transition
   */
  async evaluateSessions(): Promise<void> {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();

      // 1. Check for expired sessions (ANY state → expired)
      await this.checkExpiredSessions(nowIso);

      // 2. Check active sessions for idle transition
      await this.checkActiveSessions(nowMs, nowIso);

      // 3. Check idle sessions for spinning_down transition
      await this.checkIdleSessions(nowMs, nowIso);

      // 4. Check spinning_down sessions for suspended transition
      await this.checkSpinningDownSessions(nowIso);
    } catch (err) {
      logger.error({ err }, '[SessionLifecycle] evaluateSessions failed');
      throw err;
    }
  }

  /**
   * Check for sessions that have exceeded their TTL
   * Transition ANY state → expired
   */
  private async checkExpiredSessions(nowIso: string): Promise<void> {
    const expiredSessions = await this.db.query.user_sessions.findMany({
      where: (sessions, { lt, ne }) => and(lt(sessions.expires_at, nowIso), ne(sessions.status, 'expired')),
    });

    for (const session of expiredSessions) {
      logger.info(
        `[SessionLifecycle] Session ${session.session_id} expired (${session.status} → expired)`
      );

      // M17.3: Terminate per-user MCP connections on expiry
      if (this.userPool && session.user_id) {
        try {
          await this.userPool.terminateForUser(session.user_id);
          logger.info(`[SessionLifecycle] Terminated per-user MCPs for expired user ${session.user_id}`);
        } catch (err) {
          logger.error({ err, userId: session.user_id }, '[SessionLifecycle] Failed to terminate per-user MCPs on expiry');
          // Continue with state transition
        }
      }

      await compatUpdate(this.db, user_sessions)
        .set({ status: 'expired' })
        .where(eq(user_sessions.session_id, session.session_id));

      await this.audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action' as any,
        severity: 'info',
        session_id: session.session_id,
        user_id: session.user_id,
        auth_method: 'api_key' as any,
        source_ip: '127.0.0.1',
        action: 'session_expired',
        metadata: {
          previous_status: session.status,
          new_status: 'expired',
          expires_at: session.expires_at,
          mcp_termination: this.userPool ? 'completed' : 'not_configured',
        },
      });
    }
  }

  /**
   * Check active sessions for idle transition
   * active → idle: All connections have stale heartbeats OR no connected connections
   */
  private async checkActiveSessions(nowMs: number, nowIso: string): Promise<void> {
    const activeSessions = await this.db.query.user_sessions.findMany({
      where: (sessions, { eq }) => eq(sessions.status, 'active'),
      with: {
        connections: true,
      },
    });

    for (const session of activeSessions) {
      const idleThresholdMs = session.idle_timeout_seconds * 1000;
      const connections = (session as any).connections || [];
      const connectedConnections = connections.filter((c: any) => c.status === 'connected');

      // If no connected connections, transition to idle
      if (connectedConnections.length === 0) {
        await this.transitionToIdle(session.session_id, session.user_id, nowIso);
        continue;
      }

      // Check if ALL connected connections have stale heartbeats
      const allStale = connectedConnections.every((conn: any) => {
        const lastHeartbeat = new Date(conn.last_heartbeat_at).getTime();
        return nowMs - lastHeartbeat > idleThresholdMs;
      });

      if (allStale) {
        await this.transitionToIdle(session.session_id, session.user_id, nowIso);
      }
    }
  }

  /**
   * Transition session from active to idle
   */
  private async transitionToIdle(sessionId: string, userId: string, nowIso: string): Promise<void> {
    logger.info(`[SessionLifecycle] Session ${sessionId} transitioning to idle`);

    // Set last_activity_at to mark when idle started
    await compatUpdate(this.db, user_sessions)
      .set({
        status: 'idle',
        last_activity_at: nowIso,
      })
      .where(eq(user_sessions.session_id, sessionId));

    await this.audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action' as any,
      severity: 'info',
      session_id: sessionId,
      user_id: userId,
      auth_method: 'api_key' as any,
      source_ip: '127.0.0.1',
      action: 'session_idle',
      metadata: {
        previous_status: 'active',
        new_status: 'idle',
      },
    });
  }

  /**
   * Check idle sessions for spinning_down transition
   * idle → spinning_down: Idle for > spindown_delay_seconds
   */
  private async checkIdleSessions(nowMs: number, nowIso: string): Promise<void> {
    const idleSessions = await this.db.query.user_sessions.findMany({
      where: (sessions, { eq }) => eq(sessions.status, 'idle'),
    });

    for (const session of idleSessions) {
      const idleSince = new Date(session.last_activity_at).getTime();
      const idleDurationMs = nowMs - idleSince;
      const spindownThresholdMs = session.spindown_delay_seconds * 1000;

      if (idleDurationMs > spindownThresholdMs) {
        logger.info(`[SessionLifecycle] Session ${session.session_id} transitioning to spinning_down`);

        await compatUpdate(this.db, user_sessions)
          .set({ status: 'spinning_down' })
          .where(eq(user_sessions.session_id, session.session_id));

        await this.audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action' as any,
          severity: 'info',
          session_id: session.session_id,
          user_id: session.user_id,
          auth_method: 'api_key' as any,
          source_ip: '127.0.0.1',
          action: 'session_spinning_down',
          metadata: {
            previous_status: 'idle',
            new_status: 'spinning_down',
            idle_duration_seconds: Math.floor(idleDurationMs / 1000),
          },
        });
      }
    }
  }

  /**
   * Check spinning_down sessions for suspended transition
   * spinning_down → suspended: Immediate (MCP termination stub for M17)
   */
  private async checkSpinningDownSessions(nowIso: string): Promise<void> {
    const spinningDownSessions = await this.db.query.user_sessions.findMany({
      where: (sessions, { eq }) => eq(sessions.status, 'spinning_down'),
    });

    for (const session of spinningDownSessions) {
      logger.info(`[SessionLifecycle] Session ${session.session_id} transitioning to suspended`);

      // M17.3: Terminate per-user MCP connections before transitioning
      if (this.userPool && session.user_id) {
        try {
          await this.userPool.terminateForUser(session.user_id);
          logger.info(`[SessionLifecycle] Terminated per-user MCPs for user ${session.user_id}`);
        } catch (err) {
          logger.error({ err, userId: session.user_id }, '[SessionLifecycle] Failed to terminate per-user MCPs');
          // Continue with state transition even if termination fails
        }
      }

      await compatUpdate(this.db, user_sessions)
        .set({ status: 'suspended' })
        .where(eq(user_sessions.session_id, session.session_id));

      await this.audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action' as any,
        severity: 'info',
        session_id: session.session_id,
        user_id: session.user_id,
        auth_method: 'api_key' as any,
        source_ip: '127.0.0.1',
        action: 'session_suspended',
        metadata: {
          previous_status: 'spinning_down',
          new_status: 'suspended',
          mcp_termination: this.userPool ? 'completed' : 'not_configured',
        },
      });
    }
  }

  /**
   * Sweep expired sessions older than 24 hours
   * Deletes session and connection records (cascading)
   */
  async sweepExpiredSessions(): Promise<void> {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
      const cutoffIso = cutoff.toISOString();

      logger.info(`[SessionLifecycle] Sweeping expired sessions older than ${cutoffIso}`);

      // Find expired sessions older than 24 hours
      const sessionsToDelete = await this.db.query.user_sessions.findMany({
        where: (sessions, { eq, and, lt }) =>
          and(eq(sessions.status, 'expired'), lt(sessions.expires_at, cutoffIso)),
      });

      for (const session of sessionsToDelete) {
        logger.info(`[SessionLifecycle] Deleting expired session ${session.session_id}`);

        // Delete session (connections cascade automatically via FK)
        await compatDelete(this.db, user_sessions).where(
          eq(user_sessions.session_id, session.session_id)
        );

        await this.audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          event_type: 'admin_action' as any,
          severity: 'info',
          session_id: session.session_id,
          user_id: session.user_id,
          auth_method: 'api_key' as any,
          source_ip: '127.0.0.1',
          action: 'session_swept',
          metadata: {
            expired_at: session.expires_at,
            deleted_at: now.toISOString(),
          },
        });
      }

      // Sweep orphaned connections (connections without a parent session)
      // This shouldn't happen due to CASCADE, but defensive cleanup
      const orphanedConnections = await this.db.query.session_connections.findMany({
        where: (connections, { isNull }) => isNull(connections.session_id as any),
      });

      if (orphanedConnections.length > 0) {
        logger.warn(
          `[SessionLifecycle] Found ${orphanedConnections.length} orphaned connections, cleaning up`
        );

        for (const conn of orphanedConnections) {
          await compatDelete(this.db, session_connections).where(
            eq(session_connections.connection_id, conn.connection_id)
          );
        }
      }

      logger.info(
        `[SessionLifecycle] Sweep complete: deleted ${sessionsToDelete.length} sessions, ${orphanedConnections.length} orphaned connections`
      );
    } catch (err) {
      logger.error({ err }, '[SessionLifecycle] sweepExpiredSessions failed');
      throw err;
    }
  }
}
