const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/+$/u, '');

export async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}/api${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error('Could not reach the SecureCode server. Check your connection and try again.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The SecureCode server returned an invalid response.');
  }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

export function getSocketUrl() {
  if (import.meta.env.VITE_SOCKET_URL) return import.meta.env.VITE_SOCKET_URL;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : window.location.origin;
}
