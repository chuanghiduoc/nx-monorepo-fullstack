import { z } from 'zod';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * What every backend process needs, whatever it does.
 *
 * Split out so that a process is not made to hold configuration it never
 * reads. The worker validated against the API's schema could not boot without
 * a signing key, an allowed-origin list and a port — and the compose file
 * would have to hand it the signing key, which widens the blast radius of that
 * key for nothing.
 */
/** What `pg` uses when nobody says, stated so both schemas can name it. */
const DEFAULT_POOL_MAX = 10;

/** Long enough that somebody who changed their mind has time to say so. */
const DEFAULT_ERASURE_GRACE_DAYS = 30;

/** Fifteen minutes: a large upload on a slow connection, and no longer. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

/** 100 MiB. A ceiling a policy can state, not a promise about disk. */
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The worker's, which is larger: it runs three consumers at
 * `WORKER_CONCURRENCY` plus the sweep and the relay, and asserts that they fit
 * at boot.
 */
const DEFAULT_WORKER_POOL_MAX = 20;

export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // Queue, quota, locks. Named "critical" because it must never evict: every
  // key on it is a job, a lock or a schedule, and losing one is work that
  // silently never happened.
  REDIS_CRITICAL_URL: z
    .string()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      {
        message: 'REDIS_CRITICAL_URL must be a Redis connection string',
      },
    ),

  // Where traces go, as OTLP over HTTP — the collector's base address, without
  // the `/v1/traces` path, which the exporter appends.
  //
  // **Unset means nothing is traced, and that is a supported state.** A
  // deployment with no collector still gives every request an id and still puts
  // that id in every log line; what it loses is the join across processes.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  // Where realtime fans out. **Base, not API**, because the worker publishes
  // too — a file finishing its scan is the clearest thing a browser wants told
  // — and a bus whose two ends read different variables is a bus that works
  // until somebody points them at different servers.
  //
  // Unset means the queue's instance, which every process already has. That
  // does not violate its `noeviction` requirement: Pub/Sub stores nothing to
  // evict. The variable exists so a deployment with real realtime volume can
  // move it off the instance carrying the jobs, without a rebuild.
  REALTIME_REDIS_URL: z
    .string()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      {
        message: 'REALTIME_REDIS_URL must be a Redis connection string',
      },
    )
    .optional(),

  // The Pub/Sub channel. Configurable because two deployments sharing one Redis
  // would otherwise read each other's events, and the symptom — a stranger's
  // notification in your stream — is not one anybody guesses from.
  REALTIME_CHANNEL: z.string().min(1).max(64).default('realtime'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // How long a soft-deleted person stays before the erasure is made real. The
  // window is the feature: an erasure cannot be undone, and a mistaken one
  // with no window is a support ticket nobody can answer.
  //
  // **Base, not worker.** The API quotes this date back to the person asking
  // and the worker acts on it, so two variables would let the promise and the
  // deletion disagree — and the person would be told a date nothing honours.
  ERASURE_GRACE_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ERASURE_GRACE_DAYS),

  // --- Storage ---
  //
  // Base rather than API-only: the API signs the uploads and the worker reads
  // the objects to check them, so both processes need the same store. Two
  // schemas would let them disagree about where files are, which is a failure
  // that only appears once something has been uploaded.
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),

  // How long a signed URL lives. Long enough for a large upload over a slow
  // connection, short enough that a leaked link is not a standing grant.
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SIGNED_URL_TTL_SECONDS),

  // The largest upload a signed policy will admit. Enforced by the store at
  // the edge, so an oversized upload is refused before it is paid for.
  STORAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_UPLOAD_BYTES),

  // Where the local driver keeps objects, and where its signed URLs point.
  STORAGE_LOCAL_ROOT: z.string().min(1).default('.storage'),
  STORAGE_PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),

  // What signs a local driver's URLs.
  //
  // Its own variable rather than `BETTER_AUTH_SECRET`, which lives in the
  // API's schema: the worker reads objects too, and a base setting that
  // referred to an API-only one would fail to validate in the worker with a
  // message about a key it has no use for.
  //
  // Optional, because the S3 driver signs with the store's credentials and has
  // no need of it. The local driver refuses to start without one — a "signed"
  // URL with no key is any URL.
  STORAGE_SIGNING_SECRET: z.string().min(32).optional(),

  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('app'),
  S3_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  S3_SECRET_KEY: z.string().min(1).default('minioadmin'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * The contract between the API process and its environment.
 *
 * Validation runs at boot, so a missing or malformed variable stops the service
 * immediately with a message naming the variable — rather than surfacing as a
 * confusing failure on whichever request happens to need it first.
 */
export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().max(MAX_PORT).default(DEFAULT_PORT),

  // Which interface to bind. Absent means "decide from NODE_ENV": loopback in
  // development, so a laptop is not serving its network, and every interface
  // in production, where a container has to be reachable from outside it.
  // Optional rather than defaulted because the two answers differ.
  HOST: z.string().min(1).optional(),

  // The application's own connection, as a role bound by row-level security.
  // Migrations use MIGRATION_DATABASE_URL and are not part of a running
  // service's configuration.
  DATABASE_URL: z
    .string()
    .refine(
      (value) =>
        value.startsWith('postgresql://') || value.startsWith('postgres://'),
      {
        message: 'DATABASE_URL must be a PostgreSQL connection string',
      },
    ),

  // Two Redis roles, never one instance: the queue requires noeviction while a
  // cache wants eviction, and a single instance cannot be both. The queue's is
  // in the base schema, because a process without an HTTP surface still has a
  // queue; this one is only ever a cache.
  REDIS_CACHE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      {
        message: 'REDIS_CACHE_URL must be a Redis connection string',
      },
    ),

  // How often an idle SSE stream is given something to carry.
  //
  // A stream with no events on it is an idle socket, and something between the
  // browser and this service will eventually close one — a proxy, a load
  // balancer, a phone's radio. Without this the feature works in a test and
  // dies in a deployment, which is the worst way to find out.
  REALTIME_HEARTBEAT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(300)
    .default(15),

  // --- The assistant -------------------------------------------------------
  //
  // Which provider answers, and with which model behind each policy alias.
  // Feature code names `fast` or `smart`, never a model, so changing what
  // `smart` means is a deployment decision rather than a code change.
  //
  // `none` is the shipped default and it is a real choice: a boilerplate that
  // demanded an API key to boot would be a boilerplate nobody can run. The
  // routes then answer a problem document saying so, and one line is logged at
  // boot — the same shape the erasure role uses.
  AI_PROVIDER: z.enum(['none', 'anthropic', 'openai']).default('none'),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.url().optional(),

  // What the two aliases resolve to. Defaults name models that exist today;
  // they are variables because they will not be the current ones for long.
  AI_MODEL_FAST: z.string().min(1).default('claude-haiku-4-5'),
  AI_MODEL_SMART: z.string().min(1).default('claude-sonnet-4-5'),

  // Embeddings are a separate provider decision: Anthropic publishes no
  // embedding model, so a deployment answering with Claude still embeds with
  // something else. An OpenAI-compatible endpoint is what `AI_BASE_URL` is for.
  AI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  AI_EMBEDDING_API_KEY: z.string().min(1).optional(),
  AI_EMBEDDING_BASE_URL: z.url().optional(),

  // The soft ceiling, per organization per month, unless the organization has
  // one of its own. Soft because a completion's cost is not knowable before it
  // exists: work already in flight can carry the total past it.
  AI_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().positive().default(1_000_000),

  // How many passages a question retrieves before the model sees them.
  AI_SEARCH_LIMIT: z.coerce.number().int().positive().max(50).default(5),

  // Rate limiting is configurable so operations can tighten it without a
  // rebuild, and so tests can exercise the limit without sending a hundred
  // requests.
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),

  // Attempts on a credential route, per address, per minute. A deployment
  // leaves this alone; a test rig that signs up hundreds of times from one
  // address raises it deliberately.
  AUTH_CREDENTIAL_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .default(10),

  // Requests on any authentication route, per address, per minute. Covers
  // reads a normal page makes, so it is loose; a rig raises it anyway.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // How long a session lives, and how often using it extends the expiry.
  // An operator's decision, not a contract: a bank wants an hour where an
  // internal tool wants a fortnight, and neither is wrong.
  SESSION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  SESSION_UPDATE_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),

  // How long a browser may reuse one preflight answer. Longer costs a round
  // trip less often; shorter makes a policy change take effect sooner.
  CORS_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(600),

  // Interactive API docs: on wherever a developer runs the
  // service, off in production unless someone turns it on deliberately.
  // Absent means "decide from NODE_ENV", which is why this is optional
  // rather than defaulted.
  DOCS_ENABLED: z.stringbool().optional(),

  // Signing key for sessions and tokens. No default: a default secret is a
  // published secret, and better-auth would happily boot with one.
  BETTER_AUTH_SECRET: z.string().min(32, {
    message: 'BETTER_AUTH_SECRET must be at least 32 characters',
  }),
  // The origin the browser reaches the API on — the edge, not the container.
  // better-auth derives cookie domains and callback URLs from it.
  BETTER_AUTH_URL: z.url().default('http://localhost:3000'),

  // Which hops may set X-Forwarded-*. `trustProxy: true` would trust every
  // one of them, so any client could name its own address and the per-tenant
  // IP allowlist would guard nothing. Default: the loopback edge a developer
  // runs. In production this is the edge's address or CIDR.
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1,::1')
    .transform((value) =>
      value
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean),
    ),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4200')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  // How many database connections this process may hold.
  //
  // A separate variable from the worker's, for the same reason the connection
  // string is: the two processes have different concurrency and different
  // replica counts, and one shared number would let a value chosen to clear a
  // worker's backlog arrive at the API multiplied by its own replicas.
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_POOL_MAX),

  // Where the error types in a problem document are published. It appears in
  // every error response, so a deployment that publishes them elsewhere says
  // so here rather than shipping a link to somebody else's domain.
  PROBLEM_TYPE_BASE_URL: z.url().default('https://errors.example.com'),
});

export type AppEnv = z.infer<typeof envSchema>;

const DEFAULT_WORKER_CONCURRENCY = 5;
const DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 24;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_WORKER_CONCURRENCY = 100;

/**
 * The contract between the worker process and its environment.
 *
 * It shares the base and adds its own. It does not extend the API's: a worker
 * has no port to bind, no origins to allow and no sessions to sign, and a
 * schema that demanded them would make the deployment hand over a signing key
 * the process never uses.
 */
export const workerEnvSchema = baseEnvSchema.extend({
  // A separate variable from the API's DATABASE_URL, and required, because the
  // worker connects as a different role. One variable would mean both
  // processes connect as whichever role the shell happened to export, and the
  // one that is wrong is the one with more rights than it needs — a difference
  // nothing would report.
  WORKER_DATABASE_URL: z
    .string()
    .refine(
      (value) =>
        value.startsWith('postgresql://') || value.startsWith('postgres://'),
      {
        message: 'WORKER_DATABASE_URL must be a PostgreSQL connection string',
      },
    ),

  // How many jobs one replica runs at once. Higher finishes a backlog sooner
  // and holds more database connections while doing it, so the ceiling is the
  // connection pool, not the CPU.
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_WORKER_CONCURRENCY)
    .default(DEFAULT_WORKER_CONCURRENCY),

  // How long a finished idempotency record stays replayable before it is
  // swept. It must stay far above the claim lease: deleting a record resets
  // the fence token that makes a zombie writer safe, so a retention measured
  // in seconds would reintroduce the race the token exists to close.
  IDEMPOTENCY_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_IDEMPOTENCY_RETENTION_HOURS),

  // How often the retention sweep runs. A busier system wants it more often;
  // the interval is part of the schedule's identity, so changing it replaces
  // the schedule rather than leaving two.
  RETENTION_SWEEP_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SWEEP_INTERVAL_MINUTES),

  // Where the worker records that it is alive and its Redis is answering.
  // Optional rather than defaulted because the sensible default is the
  // platform's temporary directory, which is not a constant: hard-coding a
  // POSIX path would make the file unwritable on a developer's machine, and
  // the container sets this explicitly anyway.
  WORKER_HEARTBEAT_FILE: z.string().min(1).optional(),

  // How many database connections the worker may hold. The consumers'
  // concurrency has to fit inside it, and the worker asserts that at boot —
  // pool exhaustion arrives as a transaction timeout, which classifies as
  // retryable and then, eventually, as a dead letter.
  //
  // Larger than the API's, because the worker runs three consumers at
  // `WORKER_CONCURRENCY` — the audit trail, the webhook dispatcher and the
  // webhook sender — plus three scheduled sweeps at concurrency one and the
  // relay. At the shipped concurrency of five that is 19, which this holds
  // with almost nothing to spare: raising the concurrency means raising this
  // too. That is deliberate rather than an oversight — a worker sized past its
  // pool fails at boot naming both variables, which is the failure worth
  // having. Lowering the concurrency is the other way to make it fit.
  WORKER_DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_WORKER_POOL_MAX),

  // Where the erasure job connects, as `erasure_role` — the only role that may
  // delete a person or edit an audit record. A fourth variable rather than a
  // reused one for the same reason the worker's is not the API's: whichever
  // role a shared name held would be the role every process connected as, and
  // the one that is wrong is the one with more rights.
  ERASURE_DATABASE_URL: z
    .string()
    .refine((value) => value.startsWith('postgres'), {
      message: 'ERASURE_DATABASE_URL must be a PostgreSQL connection string',
    })
    .optional(),

  // One. The job runs daily and holds the connection for the minute it takes;
  // anything larger is a pool sitting idle for the other twenty-three hours.
  ERASURE_DATABASE_POOL_MAX: z.coerce.number().int().positive().default(1),

  // How often the job looks. Daily, because the grace window is measured in
  // weeks and a tighter schedule buys nothing.
  ERASURE_SWEEP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // How long a webhook receiver has to answer before the attempt is a
  // timeout. Short enough that a dead endpoint does not hold a worker slot,
  // long enough that a receiver doing real work in the request survives.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // How long an attempt row is kept. Long enough to answer "why did last
  // week's delivery fail"; the rows are small and the volume is endpoints
  // times events, not the outbox's delivery rate.
  WEBHOOK_DELIVERY_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(720),

  // How often the file scanner looks for uploads to check. Frequent, because
  // a file stays unusable until it has been scanned and a person is waiting.
  FILE_SCAN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1),

  // How many times a scan may fail before the file is quarantined rather than
  // retried. A file nobody could check is not one anybody should download.
  FILE_SCAN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // How long a `PENDING` record survives before it is treated as an upload
  // that never happened. Longer than a signed URL's lifetime, or the sweep
  // would remove uploads still in flight.
  STORAGE_ABANDONED_UPLOAD_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // How often that file is touched. The container's health check reads the
  // same value to decide how stale is too stale, so the two cannot drift
  // apart — which they would as two literals in two files.
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_HEARTBEAT_INTERVAL_MS),

  // --- The outbox relay -----------------------------------------------------

  // How long the relay waits when there was nothing to deliver. It is the
  // latency floor for an event, and the rate at which an idle system asks the
  // database a question whose answer is "nothing".
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1_000),

  // How many events one tick delivers. With the poll interval this is the
  // delivery rate the sweep below has to keep up with.
  OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  // How long a claim is trusted before another replica may take it back.
  //
  // Bounded at both ends. Below the worst enqueue round trip and two relays
  // deliver the same event; above the queue's deduplication window and that
  // second delivery stops being a silent no-op. The relay checks the upper
  // bound against the queue at boot.
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(60_000),

  // How long the relay waits for the queue to accept one event.
  //
  // Not optional. The queue's connection must set `maxRetriesPerRequest: null`,
  // and ioredis then queues a command against an unreachable server rather than
  // rejecting it — so without a deadline an outage stops the relay at a line
  // that looks like it is working, with no error to catch and no backoff.
  OUTBOX_ENQUEUE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),

  // How often the relay looks for claims whose relay died. A recovery path,
  // not the retry mechanism, so it runs far less often than the claim.
  OUTBOX_RECLAIM_MS: z.coerce.number().int().positive().default(30_000),

  // How often the relay removes delivered events, and how many batches it
  // takes each time.
  //
  // The product has to exceed the delivery rate the two settings above imply,
  // or the outbox grows without bound inside its own retention window. Adding
  // replicas does not close that gap: it raises both sides equally.
  OUTBOX_SWEEP_EVERY_MS: z.coerce.number().int().positive().default(60_000),
  OUTBOX_SWEEP_BATCHES: z.coerce.number().int().positive().default(10),

  // How many times an event is tried before it is given up on and somebody has
  // to look at it.
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

  // How long a delivered event stays replayable. The dedup rows that make a
  // replay safe are kept for twice this, because one that expired first would
  // let a replayed event be processed a second time.
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().positive().default(168),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
