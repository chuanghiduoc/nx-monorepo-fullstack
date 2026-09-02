export * from './generated/index.js';

// The generated index does not re-export the TanStack Query helpers, and
// openapi-ts 0.99 has no option to make it. Without this line the plugin's
// output — queryOptions and mutation factories — is unreachable through the
// package, and the @tanstack/react-query dependency pays for code nobody can
// import.
export * from './generated/@tanstack/react-query.gen.js';
