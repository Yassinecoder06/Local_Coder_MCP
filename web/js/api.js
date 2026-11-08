const mockMode = new URLSearchParams(location.search).get('mock') === '1';
const mockApi = mockMode ? await import('../mock.js') : null;

export async function request(path, options = {}) {
  if (mockApi) return mockApi.request(path, options);

  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Use the status message when the server did not return JSON.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

export function send(path, method, body) {
  return request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function streamActivity(onEntry, onError = () => {}) {
  if (mockApi) return mockApi.stream(onEntry, onError);

  const source = new EventSource('/api/activity/stream');
  source.onmessage = (event) => {
    try {
      onEntry(JSON.parse(event.data));
    } catch {
      // Ignore malformed event data and keep the connection alive.
    }
  };
  source.onerror = onError;
  return source;
}
