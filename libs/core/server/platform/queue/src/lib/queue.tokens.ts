/**
 * The Redis the queue runs on.
 *
 * A token rather than the `Redis` class: a process holds more than one Redis
 * connection — a cache, a rate limiter — and injecting by class would hand
 * whichever one happened to be registered to whichever asked. This one must be
 * the instance that cannot evict.
 */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');
