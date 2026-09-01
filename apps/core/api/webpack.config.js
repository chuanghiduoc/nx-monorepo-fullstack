const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { IgnorePlugin } = require('webpack');
const { join } = require('path');

// @nestjs/platform-fastify lazy-requires these inside try/catch, only when
// useStaticAssets() / setViewEngine() are called. They are not declared
// dependencies, so `externalDependencies: 'all'` does not cover them and webpack
// reports them as unresolved. We use neither feature; install the package and drop
// it from this list if a future phase needs static asset serving.
const UNUSED_FASTIFY_OPTIONAL_PLUGINS = /^@fastify\/(static|view)$/;

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new IgnorePlugin({ resourceRegExp: UNUSED_FASTIFY_OPTIONAL_PLUGINS }),
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
