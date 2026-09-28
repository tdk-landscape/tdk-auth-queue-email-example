import { describe, expect, it, vi } from 'vitest';
import { createReportsApi, recentPeriods, signIn } from '../src/api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('signIn', () => {
  it('posts the password grant and returns the access token', async () => {
    const doFetch = vi.fn().mockResolvedValue(json({ access_token: 'tok', token_type: 'Bearer' }));
    expect(await signIn('alice', 'alice-pass', doFetch)).toBe('tok');
    const [url, init] = doFetch.mock.calls[0];
    expect(url).toMatch(/\/auth-emulator\/token$/);
    expect(JSON.parse(init.body)).toEqual({ grant_type: 'password', username: 'alice', password: 'alice-pass' });
  });

  it("surfaces the provider's error message", async () => {
    const doFetch = vi.fn().mockResolvedValue(json({ error: 'invalid_grant', error_description: 'wrong username or password' }, 401));
    await expect(signIn('alice', 'x', doFetch)).rejects.toThrow('wrong username or password');
  });
});

describe('reports api client', () => {
  it('sends the bearer token and unwraps data', async () => {
    const doFetch = vi.fn().mockResolvedValue(json({ data: [{ id: 'r_1' }] }));
    const api = createReportsApi('tok', 'http://x', doFetch);
    expect(await api.list()).toEqual([{ id: 'r_1' }]);
    expect(doFetch.mock.calls[0][0]).toBe('http://x/api/reports');
    expect(doFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('requests a report with the crash switch', async () => {
    const doFetch = vi.fn().mockResolvedValue(json({ data: { id: 'r_2' } }, 202));
    await createReportsApi('tok', 'http://x', doFetch).request('2026-08', true);
    expect(JSON.parse(doFetch.mock.calls[0][1].body)).toEqual({ period: '2026-08', crashFirstAttempt: true });
  });

  it('throws the API error', async () => {
    const doFetch = vi.fn().mockResolvedValue(json({ error: 'invalid token' }, 401));
    await expect(createReportsApi('bad', 'http://x', doFetch).list()).rejects.toThrow('invalid token');
  });
});

describe('recentPeriods', () => {
  it('lists months newest first, across a year boundary', () => {
    expect(recentPeriods(3, new Date('2026-02-15T00:00:00Z'))).toEqual(['2026-02', '2026-01', '2025-12']);
  });
});
