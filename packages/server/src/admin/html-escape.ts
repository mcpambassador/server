/**
 * HTML Escaping Utility
 *
 * Prevents XSS attacks in template literals used by htmx fragment routes.
 * Escapes HTML special characters: & < > " '
 *
 * @see F-SEC-M10-002 XSS vulnerability remediation
 * @see CR-M10-002 htmx template XSS prevention
 */

/**
 * Escape HTML special characters to prevent XSS
 *
 * @param str - String to escape
 * @returns Escaped string safe for HTML insertion
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
