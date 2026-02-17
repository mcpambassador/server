/**
 * Privacy Utilities
 * 
 * Helper functions for handling PII (source IPs, etc.) in compliance with privacy regulations.
 * 
 * @see F-SEC-M4-007, F-SEC-M4-008: Hash IP addresses before storing/logging
 */

import { createHash } from 'crypto';

/**
 * Hash an IP address for privacy-preserving storage and logging
 * 
 * Uses SHA-256 with a date-based salt to allow correlation within a day
 * but prevent long-term tracking.
 * 
 * @param ip IP address (IPv4 or IPv6)
 * @returns Hashed IP (first 16 chars of SHA-256 hex)
 */
export function hashIp(ip: string): string {
  // Use day-based salt so IPs hash consistently within a day but change daily
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const hash = createHash('sha256')
    .update(`${ip}:${today}:mcpambassador-salt`)
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
