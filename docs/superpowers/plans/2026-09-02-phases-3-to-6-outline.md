# Phases 3–6 — Outline

Detailed task-level plans are written at each phase gate, on the real state of the
repository rather than on predictions. This outline fixes the scope, the ordering
constraints and the exit criteria so the phases cannot quietly drift.

**Spec:** `docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md`

---

## Phase 3 — Auth, tenancy, authorization, i18n

Depends on: Phase 2 transaction seam (`withTenantTransaction`) and the contract chain.

**Scope**

1. better-auth wired per ADR-0002: email/password, 2FA, organizations, access control with dynamic roles, admin plugin (ban + impersonation), multi-session (device list/revoke), API keys.
2. Tenant context: AsyncLocalStorage carrying `orgId` **and** `userId`, injected by a Prisma Client Extension that *guards* — it never opens transactions (spec §6.5).
3. RLS migrations: `ENABLE` + `FORCE` per tenant-owned table, the five table classes (`GLOBAL`, `TENANT_OWNED`, `TENANT_OPTIONAL`, `SYSTEM`, `AUTH`) with the policy template from the spec, and the five database roles. `AUTH` is the carve-out the auth library needs: a user must list every membership before any organization is active.
4. `libs/core/server/platform/authz`: `can` / `require` / `canAny` / `canAll`, an action registry, default deny, principal types (`user` | `apiKey` | `system`), `actor` vs `effectiveUser`.
5. `org_settings` (Zod-validated per key) including the per-org IP allowlist.
6. Frontend: auth screens from `shared-ui`, organization switcher, device sessions, `proxy.ts` route protection, `next-intl` (vi/en).
7. A tenant-scoped reference feature — `notes`, not user CRUD: membership lives in the auth library's own table, whose plugin owns the hooks and access control that guard it, and a second write path around them would defeat both.

**Three separate exit gates** (a green UI must not hide an unfinished foundation):

- *Auth gate* — session, API key and 2FA paths covered by tests; behaviour behind a proxy verified.
- *Tenancy gate* — negative isolation tests at **both** layers: with the extension disabled, RLS still returns nothing for another org; a tenant-scoped query with no context throws rather than returning an empty set; PgBouncer transaction mode verified; `EXPLAIN` recorded for a policy-covered query.
- *Authz gate* — registry-driven checks, default deny proven by a test, API-key principals never falling back to session auth.

---

## Phase 4 — Jobs, events, quota, flags, audit, webhooks

**Mandatory internal order** (spec §7): queue + envelope → outbox + consumer dedup → audit → quota → flags → webhooks → GDPR erasure. Webhooks and erasure only start once outbox replay and the role model are proven.

**Scope**

1. `libs/core/server/queue`: the only place importing BullMQ; job envelope (`schemaVersion`, `traceparent`, `tenantId`, `actorId`, `attempt`, `requestedAt`); per-job timeout, retry classification, DLQ; payloads carry no secrets.
2. `apps/core/worker`: separate Nest application, graceful drain on SIGTERM, Job Schedulers registered idempotently at bootstrap.
3. `libs/core/server/events`: outbox written **inside** the business transaction; relay claims with `FOR UPDATE SKIP LOCKED`; states `PENDING → PROCESSING → ENQUEUED → DEAD`; BullMQ `jobId = event_id` plus a consumer inbox table for dedup; replay window documented.
4. Audit log as an event consumer, append-only via `REVOKE`, with the column-level `erasure_role` carve-out.
5. Quota: STRICT (database-enforced reservation inside the business transaction) and FAST (Redis Lua) — two classes, named honestly.
6. Feature flags: OpenFeature + in-house provider, invalidation over Redis pub/sub with a monotonic version so out-of-order messages cannot regress state.
7. Webhooks: HMAC signature, retries, DLQ, delivery log, and SSRF protection that resolves DNS then connects to the validated IP (string validation alone is not protection).
8. GDPR erasure job with the grace period.

**Exit gate** — failure injection, not happy paths: kill the worker mid-job and the job completes after restart; two worker replicas never double-run a scheduled job; a crash between the business commit and the relay still delivers the event; concurrent quota consumption never oversells; a flag change takes effect without redeploy; a webhook cannot reach a private address.

---

## Phase 5 — Storage, realtime, AI

**Scope**

1. `feature-storage`: S3 driver (MinIO in dev) and local driver behind one interface; all three signing modes (presigned PUT, presigned POST policy, multipart); the file state machine `pending → uploaded → scanning → ready | rejected | quarantined` with a no-op `StorageScanner` by default.
2. `feature-realtime`: SSE for one-way streams and Socket.IO + Redis adapter for two-way, event contracts typed with Zod, session verified at handshake.
3. `feature-ai`: provider-agnostic AI SDK wrapper (`ai.generate` with a purpose and a model alias), pgvector migration, embeddings, a RAG demo streaming over SSE, and token usage emitted as usage events so cost lands in the quota engine.

**Exit gate** — all three upload modes pass against both drivers; with two API instances running, a notification produced on one reaches a client connected to the other; the RAG demo streams an answer and records token usage.

---

## Phase 6 — Observability and operations

**Scope**

1. OpenTelemetry traces and metrics; `traceId` shared by problem details, logs and audit records; Prometheus `/metrics` reachable only from the internal network.
2. The metric contract from the spec (queue depth, outbox states, idempotency conflicts, quota rejections, webhook deliveries, backup age) with a cardinality budget that forbids user or organization ids as labels.
3. Hardened production images: multi-stage, digest-pinned bases, non-root, `tini` as PID 1, minimal build context.
4. A dedicated migration entry that runs `prisma migrate deploy` **before** the applications start.
5. Caddy as the single edge: TLS, `/realtime/*` routed to the API with buffering off, everything else to Next, `/metrics` closed to the public.
6. Release pipeline: Trivy scan, SBOM, SLSA provenance, Cosign signing, `nx release` publishing images.
7. `docs/ops/production.md` and `docs/ops/slo.md`: firewall rules, no public Postgres/Redis/MinIO, secret handling, restart policies, log rotation, resource limits, encrypted offsite backups, and an RPO/RTO baseline that is **tested by a restore drill**, not asserted.

**Exit gate** — the production compose runs the full stack with migrations ordered first; a single request is traceable across api → queue → worker; images pass Trivy and carry SBOM, provenance and a signature; a restore drill reaches a working application from backups alone, with the measured RPO/RTO recorded.
