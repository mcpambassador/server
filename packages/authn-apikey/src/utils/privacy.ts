/**
 * Privacy Utilities
 * 
 * Helper functions for handling PII (source IPs, etc.) in compliance with privacy regulations.
 * 
 * @see F-SEC-M4-007, F-SEC-M4-008: Hash IP addresses before storing/logging
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-instance salt for IP hashing (F-SEC-M6-030 remediation)
 * Generated on first use and persisted to data directory
 */
let instanceSalt: string | null = null;

/**
 * Get or generate per-instance salt for IP hashing
 * 
 * F-SEC-M6-030 remediation: Replaced hardcoded salt with random per-instance salt
 * Salt is generated once and persisted to prevent rainbow table attacks
 */
function getInstanceSalt(): string {
  if (instanceSalt) {
    return instanceSalt;
  }

  // Try to load existing salt from data directory
  const dataDir = process.env.MCP_AMBASSADOR_DATA_DIR || './data';
  const saltPath = path.join(dataDir, '.ip-salt');

  try {
    if (fs.existsSync(saltPath)) {
      instanceSalt = fs.readFileSync(saltPath, 'utf-8').trim();
      return instanceSalt;
    }
  } catch (err) {
    // Fall through to generate new salt
  }

  // Generate new random salt (32 bytes = 64 hex chars)
  instanceSalt = randomBytes(32).toString('hex');

  // Persist salt with restrictive permissions
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(saltPath, instanceSalt, { mode: 0o600 });
  } catch (err) {
    console.error('[privacy] Failed to persist IP salt:', err);
    // Continue with in-memory salt (will regenerate on restart)
  }

  return instanceSalt;
}

/**
 * Hash an IP address for privacy-preserving storage and logging
 * 
 * Uses SHA-256 with per-instance salt + date-based salt to allow correlation
 * within a day but prevent long-term tracking and rainbow table attacks.
 * 
 * @param ip IP address (IPv4 or IPv6)
 * @returns Hashed IP (first 16 chars of SHA-256 hex)
 */
export function hashIp(ip: string): string {
  // Use day-based salt so IPs hash consistently within a day but change daily
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const salt = getInstanceSalt();
  const hash = createHash('sha256')
    .update(`${ip}:${today}:${salt}`)
    .digest('hex');
  
  // Return first 16 chars for brevity in logs/DB
  return hash.substring(0, 16);
}

/**
 * Redact IP address for logging (show first octet only)
 * 
 * Example: 192.168.1.100 → 192.*.*.*
 * 
 * @param ip IP address
 * @returns Redacted IP
 */
export function redactIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6 - show first segment only
    return ip.split(':')[0] + ':****';
  }
  
  // IPv4 - show first octet only
  return ip.split('.')[0] + '.*.*.*';
}
