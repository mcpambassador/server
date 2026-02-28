/**
 * URL Utility Functions
 *
 * SEC-M9-01 / SEC-M9-08: URL credential redaction for safe logging
 */

// Sensitive parameter names (case-insensitive)
const SENSITIVE_PARAMS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'key',
  'access_token',
]);

/**
 * Redact credential-bearing query parameters from URLs.
 * Used for safe logging, error messages, and admin API responses.
 *
 * Sensitive param names (case-insensitive): apikey, api_key, token, secret,
 * password, key, access_token
 *
 * @param url - The URL string (possibly with query params containing credentials)
 * @returns URL with credential values replaced by ***REDACTED***
 */
export function redactUrl(url: string): string {
  // Empty string → return empty string
  if (url === '') {
    return '';
  }

  try {
    // Try to parse URL
    const questionIndex = url.indexOf('?');

    // No query params → return URL unchanged
    if (questionIndex === -1) {
      return url;
    }

    const baseUrl = url.substring(0, questionIndex);
    const queryString = url.substring(questionIndex + 1);

    // Parse query parameters
    const params = new URLSearchParams(queryString);
    let modified = false;

    // Redact sensitive parameters
    for (const key of params.keys()) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
        // eslint-disable-next-line no-useless-escape
        params.set(key, '***REDACTED***');
        modified = true;
      }
    }

    // Return redacted URL
    if (modified) {
      return `${baseUrl}?${params.toString()}`;
    }

    return url;
  } catch (err) {
    // Malformed URL → return input or [invalid-url], never throw
    try {
      // Try basic string manipulation as fallback
      if (!url.includes('?')) {
        return url;
      }
      return url;
    } catch {
      return '[invalid-url]';
    }
  }
}
