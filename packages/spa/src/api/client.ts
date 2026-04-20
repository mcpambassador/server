/**
 * CSRF token manager.
 *
 * Fetches the token from GET /v1/csrf-token and caches it in memory.
 * The server sets the `_csrf` cookie; this module caches the corresponding
 * HMAC token that must be sent as the `x-csrf-token` request header.
 *
 * On a 403 response (CSRF mismatch) the cache is cleared and the next
 * mutation will re-fetch automatically — this handles token rotation after
 * session changes (login, logout).
 */
let csrfTokenCache: string | null = null;
let csrfTokenInflight: Promise<string> | null = null;

/**
 * Fetch (or return cached) CSRF token from the server.
 *
 * A pending-promise guard ensures that concurrent callers share a single
 * in-flight fetch rather than issuing N parallel requests to /v1/csrf-token.
 */
async function getCsrfToken(): Promise<string> {
  if (csrfTokenCache) return csrfTokenCache;
  if (!csrfTokenInflight) {
    csrfTokenInflight = fetch('/v1/csrf-token', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`Failed to fetch CSRF token: ${res.status}`);
        return res.json() as Promise<{ csrfToken: string }>;
      })
      .then(data => {
        csrfTokenCache = data.csrfToken;
        return data.csrfToken;
      })
      .finally(() => {
        csrfTokenInflight = null;
      });
  }
  return csrfTokenInflight;
}

/** Clear the cached token (call on login/logout so next mutation re-fetches). */
export function clearCsrfToken(): void {
  csrfTokenCache = null;
  csrfTokenInflight = null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public error: string,
    message?: string
  ) {
    super(message || error);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends RequestInit {
  params?: Record<string, string>;
}

/** HTTP methods that mutate state and require a CSRF token. */
const CSRF_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { params, ...fetchOptions } = options;

  let fullUrl = url;
  if (params) {
    const searchParams = new URLSearchParams(params);
    fullUrl = `${url}?${searchParams.toString()}`;
  }

  const method = (fetchOptions.method ?? 'GET').toUpperCase();
  const needsCsrf = CSRF_MUTATION_METHODS.has(method);

  // Build headers: attach CSRF token for all state-changing requests.
  const extraHeaders: Record<string, string> = {};
  if (fetchOptions.body) extraHeaders['Content-Type'] = 'application/json';
  if (needsCsrf) {
    extraHeaders['x-csrf-token'] = await getCsrfToken();
  }

  const response = await fetch(fullUrl, {
    ...fetchOptions,
    credentials: 'include',
    headers: {
      ...extraHeaders,
      ...fetchOptions.headers,
    },
  });

  // On CSRF rejection: clear the cached token and retry once with a fresh one.
  // This handles token staleness after login/logout/session rotation.
  if (response.status === 403 && needsCsrf) {
    clearCsrfToken();
    const freshToken = await getCsrfToken();
    const retryResponse = await fetch(fullUrl, {
      ...fetchOptions,
      credentials: 'include',
      headers: {
        ...extraHeaders,
        ...fetchOptions.headers,
        'x-csrf-token': freshToken,
      },
    });
    // Continue processing with the retried response
    return processResponse<T>(retryResponse, method);
  }

  if (response.status === 401) {
    // Use raw fetch (no interceptor) to check whether the web UI session is actually
    // expired. An MCP session expiry (or any other non-auth 401) should NOT force a
    // logout — only a truly dead web session should redirect to /login.
    try {
      const sessionCheck = await fetch('/v1/auth/session', { credentials: 'include' });
      if (sessionCheck.status === 401) {
        // Web session is genuinely expired — redirect to login.
        window.location.href = '/login';
      }
      // If sessionCheck returned 200 the web session is still alive; the 401 came
      // from a different system (e.g. MCP session expiry). Do NOT redirect.
    } catch {
      // Network error while checking session — assume session is dead.
      window.location.href = '/login';
    }
    throw new ApiError(401, 'UNAUTHORIZED', 'Unauthorized', 'Session expired or invalid');
  }

  return processResponse<T>(response, method);
}

/**
 * Parse an HTTP response into the expected type T.
 * Handles envelope format, 204 No Content, and error shapes.
 */
async function processResponse<T>(response: Response, _method: string): Promise<T> {
  if (!response.ok) {
    let errorData: unknown;
    try {
      errorData = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        'PARSE_ERROR',
        response.statusText,
        'Failed to parse error response'
      );
    }

    // Try to interpret structured envelope: { ok: false, error: { code, message } }
    if (typeof errorData === 'object' && errorData !== null) {
      const ed = errorData as Record<string, unknown>;
      const ok = ed['ok'];
      if (ok === false && ed['error']) {
        const err = ed['error'] as Record<string, unknown>;
        const code = typeof err['code'] === 'string' ? err['code'] : 'UNKNOWN_ERROR';
        const message =
          typeof err['message'] === 'string'
            ? err['message']
            : String(err['message'] ?? response.statusText);
        throw new ApiError(response.status, String(code), message, message);
      }

      // Fallback legacy fields on object
      const legacyError = ed['error'];
      const legacyMessage = ed['message'];
      if (typeof legacyError === 'string' || typeof legacyMessage === 'string') {
        throw new ApiError(
          response.status,
          'UNKNOWN_ERROR',
          typeof legacyError === 'string' ? legacyError : response.statusText,
          typeof legacyMessage === 'string' ? legacyMessage : undefined
        );
      }
    }

    // If we couldn't interpret the body, throw a generic error
    throw new ApiError(response.status, 'UNKNOWN_ERROR', response.statusText, 'An error occurred');
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  // Parse JSON response
  const json = await response.json();

  // Detect and unwrap envelope format
  if (typeof json === 'object' && json !== null && 'ok' in json) {
    // Envelope detected
    if (json.ok === false) {
      // Error envelope (should not reach here, but handle defensively)
      const error = json.error || {};
      throw new ApiError(
        response.status,
        error.code || 'UNKNOWN_ERROR',
        error.message || 'An error occurred',
        error.message
      );
    }

    if (json.ok === true) {
      // Success envelope
      if ('pagination' in json) {
        // Paginated response: return { data, pagination }
        return { data: json.data, pagination: json.pagination } as T;
      }
      // Non-paginated response: return unwrapped data
      return json.data as T;
    }
  }

  // No envelope detected (fallback for backward compatibility)
  return json as T;
}

export const apiClient = {
  get<T>(url: string, options?: RequestOptions): Promise<T> {
    return request<T>(url, { ...options, method: 'GET' });
  },

  post<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(url, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  patch<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(url, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  put<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(url, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  delete<T>(url: string, options?: RequestOptions): Promise<T> {
    return request<T>(url, { ...options, method: 'DELETE' });
  },
};

export { ApiError };
