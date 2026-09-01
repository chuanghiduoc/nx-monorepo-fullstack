import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Generates the typed client from the API's committed OpenAPI document.
 *
 * The document is an artifact of `core-api:openapi`, so the chain is
 * schema -> document -> client -> consuming app. Nothing here is written by
 * hand, and CI fails if the checked-in output stops matching the code.
 */
export default defineConfig({
  input: '../../../apps/core/api/openapi.json',
  output: {
    path: './src/generated',
    // No post-processing: the drift check compares generated output byte for
    // byte, so a formatter running in one place and not another would fail CI
    // for no reason.
    postProcess: [],
  },
  plugins: [
    {
      name: '@hey-api/client-fetch',
      // The client reads its base URL from a runtime file rather than a
      // caller-side setConfig(): a server component that forgot to call it
      // would silently fetch a relative URL. This is the vendor's own hook for
      // the case (`createClientConfig`), so nothing is patched by hand.
      // Written with the .js extension the emitted import needs: the generator
      // copies this string into the import verbatim, and a '.ts' there is a
      // TS5097 error under our module resolution.
      runtimeConfigPath: './src/client-config.js',
    },
    '@hey-api/typescript',
    '@hey-api/sdk',
    // queryOptions rather than generated hooks: the caller decides how to use
    // them (useQuery, prefetch, server-side fetch), which matters because the
    // app renders on the server by default.
    '@tanstack/react-query',
  ],
});
