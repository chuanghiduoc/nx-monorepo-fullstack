// Drives the production stack and reports what it cost.
//
//   node tools/scripts/smoke.mjs [--seconds 30] [--concurrency 20]
//
// The point is a number, not a pass. The spec's RAM figure for this stack is
// "an estimate, not a commitment", and an estimate nobody has measured is a
// guess — so this measures it: latency and error rate from the service's own
// histogram, memory and CPU from Docker, before and after, on a dataset it
// creates itself.
//
// It reads `/api/metrics` through the container rather than through the edge,
// because the edge answers 404 for it deliberately.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:8080';
const ORIGIN = process.env.SMOKE_ORIGIN ?? BASE;
const COMPOSE = [
  'compose',
  '-f',
  'docker-compose.prod.yml',
  '--env-file',
  '.env.prod',
];

const options = parseArguments(process.argv.slice(2));

/** How many notes the sample dataset holds before the load starts. */
const SEED_NOTES = Number(process.env.SMOKE_SEED ?? 2_000);

main().catch((failure) => {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exitCode = 1;
});

async function main() {
  console.log(
    `Smoke: ${String(options.concurrency)} concurrent readers for ${String(options.seconds)}s, ` +
      `over a ${String(SEED_NOTES)}-note dataset.\n`,
  );

  await assertUp();

  const member = await signUpWithOrganisation();
  await seed(member, SEED_NOTES);

  const before = await snapshot();
  const load = await drive(member);
  const after = await snapshot();

  report(load, before, after);
}

/** Refuses to report numbers about a stack that is not there. */
async function assertUp() {
  const response = await fetch(`${BASE}/api`).catch(() => undefined);

  if (response?.ok !== true) {
    throw new Error(
      `Nothing is answering on ${BASE}. Start it first: pnpm prod:up`,
    );
  }
}

/**
 * Rows through the API, deliberately.
 *
 * Seeding with SQL would be faster and would skip the write path — and the
 * write path is half of what this is measuring the memory of.
 */
async function seed(member, count) {
  const started = Date.now();
  let done = 0;

  // In batches, so the seed itself is not the load test.
  const batch = 20;

  for (let index = 0; index < count; index += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - index) }, (_, offset) =>
        request('POST', '/api/v1/notes', member, {
          title: `Seed ${String(index + offset)}`,
          body: 'x'.repeat(200),
        }).then(() => {
          done += 1;
        }),
      ),
    );
  }

  console.log(
    `Seeded ${String(done)} notes in ${seconds(Date.now() - started)}s.`,
  );
}

/** Reads for a fixed time at a fixed concurrency, counting what came back. */
async function drive(member) {
  const endAt = Date.now() + options.seconds * 1_000;
  const outcomes = new Map();
  let requests = 0;

  const worker = async () => {
    while (Date.now() < endAt) {
      const response = await request('GET', '/api/v1/notes?limit=50', member);
      outcomes.set(response.status, (outcomes.get(response.status) ?? 0) + 1);
      requests += 1;
      // The body has to be read or the socket is not returned to the pool, and
      // the client becomes the bottleneck rather than the service.
      await response.arrayBuffer();
    }
  };

  const started = Date.now();
  await Promise.all(
    Array.from({ length: options.concurrency }, () => worker()),
  );
  const elapsed = (Date.now() - started) / 1_000;

  return { requests, elapsed, outcomes };
}

/** Memory and CPU per container, and the service's own view of itself. */
async function snapshot() {
  const { stdout } = await run('docker', [
    ...COMPOSE,
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
  ]);

  const containers = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, memory, cpu] = line.split('\t');
      return { name: shortName(name ?? ''), memory: memory ?? '', cpu: cpu ?? '' };
    })
    .filter((row) => row.name !== '');

  return { containers, metrics: await scrape() };
}

/**
 * The metrics endpoint, from inside the container.
 *
 * The edge answers 404 for it on purpose, so a smoke test that went through the
 * edge would be measuring the 404.
 */
async function scrape() {
  const { stdout } = await run('docker', [
    ...COMPOSE,
    'exec',
    '-T',
    'api',
    'node',
    '-e',
    "fetch('http://127.0.0.1:3000/api/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))",
  ]);

  return stdout;
}

function report(load, before, after) {
  const perSecond = load.requests / load.elapsed;
  const failures = [...load.outcomes.entries()]
    .filter(([status]) => Number(status) >= 400)
    .reduce((total, [, count]) => total + count, 0);

  console.log('\n--- load ---');
  console.log(`requests            ${String(load.requests)}`);
  console.log(`throughput          ${perSecond.toFixed(1)}/s`);
  console.log(
    `outcomes            ${[...load.outcomes.entries()].map(([s, n]) => `${String(s)}×${String(n)}`).join(' ')}`,
  );
  console.log(
    `error rate          ${((failures / Math.max(load.requests, 1)) * 100).toFixed(2)}%`,
  );

  const p95 = percentileFrom(after.metrics, before.metrics);
  console.log(
    `p95 (this run)      ${p95 === undefined ? 'not enough samples' : `${p95.toFixed(3)}s`}`,
  );

  console.log('\n--- memory, before → after ---');
  for (const row of after.containers) {
    const was = before.containers.find((c) => c.name === row.name);
    console.log(
      `${row.name.padEnd(18)} ${(was?.memory ?? '?').padEnd(22)} → ${row.memory.padEnd(22)} cpu ${row.cpu}`,
    );
  }

  console.log(
    '\nThese are this machine\'s numbers on one host. Record them beside the ones\n' +
      'in docs/ops/capacity.md, and re-run before believing any of them elsewhere.',
  );
}

/**
 * The 95th percentile of what this run added to the histogram.
 *
 * Differenced against the snapshot taken before the load, so a service that has
 * been up for a week does not report the week's latency.
 */
function percentileFrom(after, before) {
  const buckets = (text) => {
    const found = new Map();

    for (const match of text.matchAll(
      /^http_request_duration_seconds_bucket\{([^}]*)\}\s+(\d+)/gm,
    )) {
      const labels = match[1] ?? '';
      if (!labels.includes('route="/api/v1/notes"')) continue;

      const le = /le="([^"]+)"/.exec(labels)?.[1];
      if (le === undefined) continue;

      found.set(le, (found.get(le) ?? 0) + Number(match[2]));
    }

    return found;
  };

  const now = buckets(after);
  const then = buckets(before);

  const rows = [...now.entries()]
    .map(([le, count]) => ({ le, count: count - (then.get(le) ?? 0) }))
    .filter((row) => row.le !== '+Inf')
    .sort((a, b) => Number(a.le) - Number(b.le));

  const total = Math.max(...rows.map((row) => row.count), 0);

  if (total === 0) return undefined;

  const target = total * 0.95;
  const hit = rows.find((row) => row.count >= target);

  return hit === undefined ? undefined : Number(hit.le);
}

function parseArguments(argv) {
  const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : Number(argv[at + 1]);
  };

  return {
    seconds: value('seconds', 30),
    concurrency: value('concurrency', 20),
  };
}

function shortName(name) {
  return name.replace(/^nx-monorepo-fullstack-prod-/, '').replace(/-\d+$/, '');
}

function seconds(ms) {
  return (ms / 1_000).toFixed(1);
}

let sequence = 0;

async function signUpWithOrganisation() {
  const email = `smoke-${String(Date.now())}-${String((sequence += 1))}@example.com`;

  const signedUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'password123', name: 'Smoke' }),
  });

  if (!signedUp.ok) {
    throw new Error(
      `sign-up failed: ${String(signedUp.status)} ${await signedUp.text()}`,
    );
  }

  const cookie = (signedUp.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');

  const organisation = await (
    await fetch(`${BASE}/api/auth/organization/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({
        name: 'Smoke',
        slug: `smoke-${String(Date.now())}`,
      }),
    })
  ).json();

  await fetch(`${BASE}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ organizationId: organisation.id }),
  });

  return { cookie };
}

function request(method, path, member, body) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: member.cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
