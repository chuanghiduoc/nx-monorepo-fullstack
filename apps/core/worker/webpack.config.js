const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { IgnorePlugin } = require('webpack');
const { join } = require('path');

// NestJS resolves a number of optional integrations through lazy `require` calls
// wrapped in try/catch. Webpack still analyses them statically and fails the build
// for every one that is not installed, even though the runtime never loads them.
// This project deliberately uses none of them — validation is Zod-based — so they
// are excluded from the bundle. When one is genuinely needed, e.g.
// @nestjs/websockets for realtime, install it and remove it from this list.
const UNUSED_OPTIONAL_INTEGRATIONS =
  /^(class-validator|class-transformer\/storage|cache-manager|@fastify\/(static|view)|@nestjs\/(websockets|microservices|platform-express)(\/.*)?|@valkey\/valkey-glide|pg-native)$/;

module.exports = {
  // Dependencies ship.js without the.ts they were built from; source-map-loader
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
    new IgnorePlugin({ resourceRegExp: UNUSED_OPTIONAL_INTEGRATIONS }),
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      // Everything in one bundle, so the artifact runs with nothing beside it
      // but a Node runtime: no install step in the image, nothing to resolve,
      // and no way for the image's dependency tree to differ from the one the
      // tests ran against. Proven by copying `dist` outside the workspace and
      // starting it — it answers.
      //
      // This works because `IgnorePlugin` above already excludes the optional
      // peers NestJS lazy-requires. Without that exclusion, bundling turns
      // every unused optional into a build error, which is why this setting
      // used to be `'all'`.
      externalDependencies: 'none',
      sourceMap: true,
    }),
  ],
};
