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

async function request<T>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const { params, ...fetchOptions } = options;
  
  let fullUrl = url;
  if (params) {
    const searchParams = new URLSearchParams(params);
    fullUrl = `${url}?${searchParams.toString()}`;
  }

  const response = await fetch(fullUrl, {
    ...fetchOptions,
    credentials: 'include',
    headers: {
      ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...fetchOptions.headers,
    },
  });

  if (response.status === 401) {
    // Redirect to login on unauthorized
    window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', 'Unauthorized', 'Session expired or invalid');
  }

  if (!response.ok) {
    let errorData: any;
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

    // Check if it's an envelope error response: { ok: false, error: { code, message, details? } }
    if (errorData.ok === false && errorData.error) {
      throw new ApiError(
        response.status,
        errorData.error.code || 'UNKNOWN_ERROR',
        errorData.error.message || 'An error occurred',
        errorData.error.message
      );
    }

    // Fallback to legacy error format: { error: string, message?: string }
    throw new ApiError(
      response.status,
      'UNKNOWN_ERROR',
      errorData.error || response.statusText,
      errorData.message
    );
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
