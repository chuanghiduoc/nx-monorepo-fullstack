import type { CreateClientConfig } from './generated/client.gen.js';

const DEFAULT_API_URL = 'http://localhost:3000';

/**
 * Called by the generated client when it is created.
 *
 * Every consumer gets the same base URL without having to remember to set it,
 * and a missing `API_URL` fails towards local development rather than towards
 * an accidental relative fetch against whatever host is serving the page.
 */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: process.env['API_URL'] ?? DEFAULT_API_URL,
});
