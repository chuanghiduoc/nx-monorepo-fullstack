/**
 * The name of the environment variable holding this process's connection string.
 *
 * The name rather than the value, because the value is read when the client is
 * constructed and the name is what belongs in the failure message: a process
 * that will not start says which variable it was looking at.
 *
 * It is the application's decision because the two applications connect as
 * different roles. One variable shared between them would mean both connect as
 * whichever role the shell happened to export, and the one that is wrong is
 * the one with more rights than it needs.
 */
export const DATABASE_URL_VARIABLE = Symbol('DATABASE_URL_VARIABLE');

/**
 * The name of the environment variable holding this process's pool size.
 *
 * Named for the same reason as the connection string above, and split for the
 * same reason: the API and the worker hold different numbers of connections,
 * and a single variable would give whichever process read it the other's.
 */
export const DATABASE_POOL_VARIABLE = Symbol('DATABASE_POOL_VARIABLE');
