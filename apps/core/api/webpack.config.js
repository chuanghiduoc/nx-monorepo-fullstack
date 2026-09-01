const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { IgnorePlugin } = require('webpack');
const { join } = require('path');

// NestJS resolves a number of optional integrations through lazy `require()` calls
// wrapped in try/catch. Webpack still analyses them statically and fails the build
// for every one that is not installed, even though the runtime never loads them.
// This project deliberately does not use any of them (validation is Zod-based per
// spec §3), so they are excluded from the bundle. When a phase introduces one of
// these — e.g. @nestjs/websockets for realtime — install it and remove it here.
const UNUSED_NEST_OPTIONAL_INTEGRATIONS =
  /^(class-validator|class-transformer|cache-manager|@fastify\/(static|view)|@nestjs\/(websockets|microservices)(\/.*)?)$/;

module.exports = {
  // Dependencies ship .js without the .ts they were built from; source-map-loader
  // then warns once per file. The warnings say nothing actionable about this code.
  ignoreWarnings: [/Failed to parse source map/],
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new IgnorePlugin({ resourceRegExp: UNUSED_NEST_OPTIONAL_INTEGRATIONS }),
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      // NestJS lazy-requires many optional peers (class-validator, microservices,
      // websockets, @fastify/static...). Bundling them turns every unused optional
      // into a build error, so dependencies stay external and are installed from the
      // generated package.json at runtime — this is also what the Docker image needs.
      externalDependencies: 'all',
      generatePackageJson: true,
      sourceMap: true,
    }),
  ],
};
