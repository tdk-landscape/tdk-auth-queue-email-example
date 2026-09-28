export interface Report {
  id: string;
  period: string;
  status: 'queued' | 'processing' | 'retrying' | 'sent' | 'failed';
  attempts: number;
  crashFirstAttempt: boolean;
  rows?: number;
  sentTo?: string;
  error?: string;
  requestedAt: string;
  updatedAt: string;
}

export interface Profile {
  sub: string;
  name?: string;
  email?: string;
}

// TDK does not publish backend ports on localhost. Traefik routes each backend at
// api.<project>.localhost/api/<name>, with that prefix stripped before the request
// reaches the service.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://api.tdk-auth-queue-email-example.localhost/api';
export const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? `${API_BASE}/auth-emulator`;
export const REPORTS_URL = import.meta.env.VITE_REPORTS_URL ?? `${API_BASE}/reports`;
export const MAILPIT_URL = import.meta.env.VITE_MAILPIT_URL ?? 'http://localhost:8025';

type Fetch = typeof fetch;

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `request failed (${res.status})`);
  return (body.data ?? body) as T;
}

/** Password grant against whatever OIDC provider AUTH_URL points at. */
export async function signIn(username: string, password: string, doFetch: Fetch = fetch): Promise<string> {
  const res = await doFetch(`${AUTH_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', username, password }),
  });
  return (await unwrap<{ access_token: string }>(res)).access_token;
}

export function createReportsApi(token: string, baseUrl = REPORTS_URL, doFetch: Fetch = fetch) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    async me(): Promise<Profile> {
      return unwrap<Profile>(await doFetch(`${baseUrl}/api/me`, { headers }));
    },
    async list(): Promise<Report[]> {
      return unwrap<Report[]>(await doFetch(`${baseUrl}/api/reports`, { headers }));
    },
    async request(period: string, crashFirstAttempt: boolean): Promise<Report> {
      const res = await doFetch(`${baseUrl}/api/reports`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ period, crashFirstAttempt }),
      });
      return unwrap<Report>(res);
    },
  };
}

/** The last `count` months as YYYY-MM, newest first. */
export function recentPeriods(count = 3, from = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export const STATUS_LABEL: Record<Report['status'], string> = {
  queued: 'Queued',
  processing: 'Working',
  retrying: 'Retrying',
  sent: 'Emailed',
  failed: 'Failed',
};
