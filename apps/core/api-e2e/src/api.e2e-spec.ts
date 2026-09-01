import { describe, it, expect } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

describe('core-api', () => {
  it('serves the root endpoint under the /api prefix', async () => {
    const response = await fetch(`${API_URL}/api`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Hello API' });
  });

  it('returns a request id header so logs can be correlated', async () => {
    const response = await fetch(`${API_URL}/api`);

    // Phase 2 adds the header; until then this documents the expectation.
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('does not expose routes outside the /api prefix', async () => {
    const response = await fetch(`${API_URL}/`);

    expect(response.status).toBe(404);
  });
});
