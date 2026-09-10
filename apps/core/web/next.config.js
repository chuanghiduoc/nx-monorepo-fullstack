//@ts-check
const { join, relative } = require('node:path');
const createNextIntlPlugin = require('next-intl/plugin');

/**
 * The request configuration, as a path that resolves from wherever this file is
 * read.
 *
 * The plugin resolves what it is given against `process.cwd()`, and this config
 * is read from two directories: by Next, from this project, and by
 * `@nx/next/plugin` from the workspace root while it builds the project graph.
 * A fixed `./src/i18n/request.ts` exists in the first and not the second, and
 * next-intl 4.14 turned that into a thrown error — which fails the *graph*, so
 * `pnpm dev` stops before it starts anything, with a message about
 * translations.
 *
 * An absolute path would satisfy the check and break Turbopack, which the
 * plugin's own comment says cannot alias one. A path made relative to the
 * current directory is right in both.
 */
function requestConfigPath() {
  const relativePath = relative(
    process.cwd(),
    join(__dirname, 'src', 'i18n', 'request.ts'),
  ).split('\\').join('/');

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // shared-ui is an internal workspace package published as TypeScript source
  // (Nx consumes it through the @workspace/source condition), so Next must compile it.
  transpilePackages: ['@workspace/shared-ui'],
  // A server that carries only the files it actually imports, so the image
  // needs no install step and no workspace around it. Without this, running
  // the built application means shipping the whole monorepo's node_modules.
  output: 'standalone',
  // The trace starts at the workspace root, not at this project: the packages
  // this app imports are siblings in the same install, and a trace rooted here
  // would miss every one of them.
  outputFileTracingRoot: join(__dirname, '..', '..', '..'),
  // The framework's own runtime dependencies, carried whole.
  //
  // The tracer follows imports, and the framework reaches these through a
  // require hook instead — so it copies each package's manifest and none of
  // its code, and the standalone server dies on the first one it needs:
  // `Cannot find module 'styled-jsx/package.json'`, then `@swc/helpers`, then
  // `@next/env`. Adding them one failure at a time is how you discover the
  // list; taking the framework's whole dependency set is how you stop.
  //
  // Named whole rather than file by file, because the hook resolves subpaths
  // at runtime: copying only an entry point moves the failure rather than
  // fixing it.
  outputFileTracingIncludes: {
    '/**': [
      '../../../node_modules/@next/env/**',
      '../../../node_modules/@swc/helpers/**',
      '../../../node_modules/baseline-browser-mapping/**',
      '../../../node_modules/caniuse-lite/**',
      '../../../node_modules/postcss/**',
      '../../../node_modules/styled-jsx/**',
    ],
  },
};

// Points the plugin at the request configuration; without it, translations
// resolve to nothing at runtime and every message renders as its own key.
const withNextIntl = createNextIntlPlugin(requestConfigPath());

module.exports = withNextIntl(nextConfig);
