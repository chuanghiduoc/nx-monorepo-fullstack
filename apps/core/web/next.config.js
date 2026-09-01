//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  // shared-ui is an internal workspace package published as TypeScript source
  // (Nx consumes it through the @org/source condition), so Next must compile it.
  transpilePackages: ['@org/shared-ui'],
};

module.exports = nextConfig;
