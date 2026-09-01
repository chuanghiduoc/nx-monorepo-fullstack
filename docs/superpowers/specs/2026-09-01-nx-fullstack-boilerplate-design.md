# Spec thiết kế — Nx Full-stack Boilerplate đa mảng (NestJS + Next.js, polyglot-ready)

- **Ngày:** 2026-09-02 (v14 — vá review vòng 6: tenant context matrix + SQL policy mẫu, role model 5 role, runtime enforcement root client, routing contract, idempotency replay contract, outbox consumer dedup, MUST/SHOULD/SPIKE/UPGRADE, contract artifacts, failure matrix. Tên file giữ ngày khởi tạo 09-01)
- **Trạng thái:** Chờ đóng dấu chốt sau 6 vòng review — Phase 1 được phép bắt đầu (blockers không chạm Phase 1)
- **Vị trí workspace:** `D:\nx-monorepo-fullstack\nx-monorepo-fullstack\`
- **Ghi chú:** Spec move vào `<workspace>/docs/superpowers/specs/` và commit ở bước đầu Phase 1.

## 1. Mục tiêu & phạm vi

Nền tảng monorepo Nx **đa mảng** — xây một lần, tái dùng cho CRM, ERP, HRM,
CMS, AI Platform, Video Platform, E-commerce Admin, SaaS B2B/B2C...: NestJS +
Next.js, polyglot-ready, i18n (vi/en). Hiệu năng cao, multi-instance-safe,
boundaries enforce bằng máy.

**Kiến trúc hai tầng:** (a) **CORE — nền chung mọi dự án nhận**: Nx, NestJS,
Next, Postgres, Redis, OpenAPI contract, validation, auth, authz, quota
engine, events/outbox, testing, migration, observability, security, CI/CD;
(b) **PACKS composable — nhận theo nhu cầu**: tenant/organizations,
entitlements, flags, webhooks, audit, storage, realtime, AI. Mỗi `feature-*`
lib độc lập, tháo được, có doc "dùng khi nào / bỏ thế nào" — tránh "clone
nhận nguyên 50 module khi chỉ cần 10". Dự án không multi-tenant thì không
đánh dấu bảng tenant-owned, nền không đổi.

**Không thuộc phạm vi:** K8s/Helm, service non-JS thực tế (chỉ quy ước),
GraphQL mặc định (6.4), cổng thanh toán (hook point), CMS/analytics engine.

## 2. Ràng buộc bất di bất dịch

1. **Không viết version thủ công** — generator/installer resolve; ngoại lệ chỉ
   khi vendor chỉ định (hey-api pin exact; Prisma 7; Nx TS7 dual-install) —
   ghi nguồn. Renovate duy trì version sau đó.
2. **Không viết lại cái đã có** — CLI/generator/thư viện chuẩn.
3. **Flexibility = containment** — swap công nghệ chỉ đụng lib nhỏ (facade:
   queue, events, authz, storage, flags, AI provider).
4. pnpm catalogs — version dùng chung một chỗ.
5. **Multi-instance-safe mặc định** — không state trong process.
6. **Naming theo scope** — không theo vai trò/framework.
7. **Mọi lựa chọn "làm nhẹ có chủ đích" BẮT BUỘC có mục trong
   `docs/upgrades.md`**: tín hiệu khi nào cần nâng + các bước nâng đơn giản.
   Không có mục upgrade = không được phép làm nhẹ.

**Nhãn quyết định (tách invariant khỏi option):**

| Nhãn | Ý nghĩa | Ví dụ |
|---|---|---|
| MUST | Vi phạm = sai kiến trúc/security | RLS FORCE, không leak Prisma, outbox cùng transaction, withTenantTransaction duy nhất, default-deny authz |
| SHOULD | Mặc định của boilerplate, project override được bằng ADR | Fastify, SSE + Socket.IO, không global FE state, cursor pagination |
| SPIKE | Chưa được coi là quyết định cho tới khi có PoC + ADR | better-auth/Fastify, TS7 dual-install |
| UPGRADE | Không có ở baseline, chỉ có đường nâng | Kafka, ReBAC, gateway, billing, SSO |

**Version policy (giải mâu thuẫn "không viết version tay" vs các con số trong
spec):** 5 loại được phân biệt — (a) *catalog range* do installer resolve
(mặc định); (b) *vendor-mandated exact pin* (hey-api) — có owner + trigger
trong upgrades.md; (c) *major-line choice* (Prisma 7, PG 18, Nx 23 — chọn
dòng major theo vendor guidance, số minor/patch do installer/Renovate);
(d) *Docker image digest pin* (production hardening); (e) *lockfile* do pnpm
sinh. Con số major trong spec là quyết định kiến trúc, không phải "viết
version tay".

## 3. Quyết định stack (đã verify docs 09/2026)

| Hạng mục | Lựa chọn | Ghi chú |
|---|---|---|
| Monorepo | Nx 23, preset `ts`, pnpm, Renovate | Cache/affected; project references |
| Backend / Frontend | NestJS 11 (`@nx/nest`) / Next.js 16 (`@nx/next`, Turbopack) | Generator chính chủ |
| HTTP adapter | **Fastify** (`@nestjs/platform-fastify`) | Throughput ~2x Express; pino là logger gốc của Fastify; dùng plugin `@fastify/*` chính chủ (helmet, multipart); better-auth có integration lib hỗ trợ Fastify |
| DX generators | **Nx local plugin trong `tools/`**: generator `feature-lib`, `product-scope` tự scaffold đúng quy ước (tags, boundaries, test) | Quy ước enforce bằng generator, không bằng trí nhớ. "1 lib = 1 domain" là mặc định, KHÔNG phải luật cứng — domain lớn được phép supporting libs (`feature-orders-contract/-jobs/-testing`) |
| API contract | REST + OpenAPI; hey-api + TanStack Query (pin exact) | Xương sống polyglot |
| Validation | Zod + nestjs-zod | Schema → validation + type + OpenAPI |
| DB | PostgreSQL 18 + Prisma 7; **UUIDv7** `dbgenerated("uuidv7()")`; TIMESTAMPTZ | PG18 uuidv7() built-in; pgvector sẵn cho AI |
| TypeScript | TS7 native, dual-install chính thức Nx | 8-12x; rollback 2 dòng |
| Test / Lint | Vitest + Playwright; integration bằng **Testcontainers** (PG/Redis thật, cô lập, song song) / ESLint flat + Prettier + **knip** (quét dep/export thừa) | Hướng Nx v23 |
| Git hooks | **Lefthook** (parallel, Go) + commitlint + gitleaks pre-push | Nhanh hơn husky |
| Supply-chain security | **5 lớp: Gitleaks → OSV-Scanner → Semgrep → Trivy → SBOM + SLSA + Cosign** | Gate theo lifecycle: **PR** = gitleaks + osv + semgrep + knip (fail = chặn merge, ignore phải có lý do trong repo); **nightly** = full history/deep scan, SARIF artifact; **release** = trivy + SBOM + SLSA + cosign (keyless OIDC) |
| Queue admin | **Bull Board** UI (route bảo vệ bằng authz, bật theo env) | Nhìn thấy job/DLQ |
| UI / i18n | Tailwind + shadcn (`libs/shared/ui`) / next-intl | Design system dùng chung mọi FE |
| Auth | better-auth: 2FA, organizations, AC + dynamic roles, admin/impersonation, **multi-session (device mgmt)**, **@better-auth/api-key** (key per-org, rate-limit per-key) | Không tự viết auth |
| Authz | **Facade `authz.can(user, action, resource, ctx)`** — ruột: better-auth AC (RBAC bậc 3) + ABAC-lite (ownership/attributes); ReBAC (OpenFGA/SpiceDB) cắm sau facade khi cần | Mọi check qua một cửa; cấm check rải rác |
| Multi-tenancy | Organizations + 2 lớp: Prisma Extension inject orgId + **RLS ENABLE+FORCE** | Policy là hợp đồng |
| Tenant Settings | Bảng `org_settings` key-value có Zod schema + UI; chứa cả IP whitelist per-org | 6.5 |
| Entitlements/Quota | Quota 2 class: **STRICT (DB-enforced trong withTenantTransaction — billing/seats)** + **FAST (Redis Lua — rate-limit/soft)**; usage events; hook `onPlanChanged` | 6.7; không billing |
| Feature Flags | **OpenFeature SDK** (facade chuẩn CNCF) + provider in-house (env + org-scoped flags DB + Redis cache); swap Unleash/Flagsmith = đổi provider | 6.12 |
| Domain events | Outbox cùng transaction + relay ở worker | 6.10; đường lên Kafka |
| Queue/Jobs | BullMQ sau facade `queue`; worker riêng, graceful drain; Job Schedulers | 6.1 |
| Distributed lock | Util Redis lock (SET NX PX / redlock) trong `core` | Tác vụ "một người chạy" ngoài queue |
| Redis topology | **2 Redis service THẬT (container riêng)**: `redis-critical` (`maxmemory-policy=noeviction`, AOF: BullMQ, quota, rate-limit, lock, idempotency-cache) + `redis-cache` (`allkeys-lru`: cache, realtime transient) | BullMQ BẮT BUỘC noeviction, cache lại cần eviction — một instance không thỏa cả hai; eviction/restart không được giết cơ chế critical |
| Mail | nodemailer → Mailpit; qua queue; template theo locale | |
| Storage | S3-compatible + local driver, MinIO dev, 3 dạng ký | 6.2 |
| Realtime | SSE + Socket.IO + Redis adapter | 6.3 |
| Search | PG FTS + pg_trgm demo; thang Meili/Typesense → Elastic ghi upgrades | 6.11 |
| AI-ready | **Vercel AI SDK v7** (provider-agnostic) + pgvector + streaming qua SSE + AI job dài qua queue + token usage → usage events | 6.13 |
| Audit log | Consumer domain events → `audit_logs` append-only | 6.6 |
| Webhooks | Engine: HMAC signature, retry/backoff, DLQ, delivery logs, chống SSRF | 6.8 |
| Security | Helmet, CORS theo env, **CSRF** (SameSite + origin-check; better-auth tự bảo vệ /api/auth), rate limit Redis (throttler), **IP whitelist per-org**, refresh rotation, Idempotency-Key, API keys, webhook signature | 6.14 |
| Observability | **Pino + Request ID + Trace ID (OTel) + Prometheus /metrics + Grafana + Loki** — dev compose dùng grafana/otel-lgtm (1 container) | 6.15 |
| Docker/Release/CI | Multi-stage; @nx/docker; nx release + conventional commits; `nx g ci-workflow` | Nx Cloud opt-in |
| Docs | ADR + `docs/upgrades.md` (ràng buộc 7) | |

## 4. Kiến trúc workspace — scope: platform / product

```
apps/
  platform/              # dịch vụ nền tảng dùng chung mọi sản phẩm (graduation)
    auth/                # identity service riêng — KHI có sản phẩm thứ 2 (mặc định: auth là module trong core-api)
    gateway/             # API gateway — KHI có ≥2 backend service
  core/                  # sản phẩm mẫu (clone → đổi tên crm/, hrm/, cms/...)
    api/  api-e2e/  worker/  web/  web-e2e/
  admin/web              # console quản trị chung (khi cần)
libs/
  shared/                # scope:shared
    ui/  api-client-core/  i18n/
  core/
    server/              # platform:node
      core/              # config+env, pino, filter RFC 9457, terminus, throttler,
                         # idempotency, distributed lock, pagination/cursor helpers
      data-access-db/    # Prisma DUY NHẤT ở đây (+ tenant context, RLS helpers)
      queue/             # bullmq DUY NHẤT ở đây
      events/            # domain events + outbox
      authz/             # facade authz DUY NHẤT — cấm check quyền ngoài đây
      quota/             # quota engine atomic (platform-infra — 6.7)
      feature-auth/      # better-auth: orgs, AC, admin, multi-session, api-key
      feature-users/     # user CRUD mẫu (tenant-scoped)
      feature-entitlements/  # plans, guard, onPlanChanged, UI (gọi quota infra)
      feature-flags/     # OpenFeature + in-house provider
      feature-audit/  feature-webhooks/  feature-storage/  feature-realtime/
      feature-ai/        # AI SDK provider abstraction, embeddings, RAG demo
      testing/           # harness, fixtures, factories, Testcontainers setup
    web/                 # platform:web — component riêng product app
docs/  (superpowers/specs/, adr/, adding-a-language.md, upgrades.md)
docker-compose.yml       # dev: PG18, Redis, Mailpit, MinIO, grafana/otel-lgtm
```

**Luật ranh giới** (tags scope/platform/type — chốt TRƯỚC khi viết generator):

1. `scope:X` chỉ import `scope:X` + `scope:shared`.
2. `platform:web` ↮ `platform:node` (cửa: api-client-*).
3. **`type:feature` KHÔNG import `type:feature`** — cross-feature giao tiếp
   qua domain events (6.10) hoặc contracts (Zod schema trong shared); nếu
   một feature bị nhiều feature khác cần import trực tiếp, đó là tín hiệu nó
   thực chất là infra → hạ xuống lớp platform-infra (như quota, authz).
4. `type:data-access` không import `type:feature`; `type:ui` không import
   `type:data-access`.
5. Prisma chỉ ở data-access-db; bullmq chỉ ở queue; AWS SDK chỉ ở
   feature-storage; permission check chỉ ở authz.
5b. **Cấm leak Prisma qua type system:** `Prisma.*` types
   (`Prisma.UserWhereInput`, `Prisma.UserGetPayload`,
   `Prisma.TransactionClient`...) KHÔNG được xuất hiện trong contract của
   feature — data-access trả **domain DTO** (`User`, `UserPage`,
   `CreateUserInput`...). Import boundary mà leak type thì swap ORM vẫn vỡ
   toàn codebase.
6. Phân biệt semantic: **platform-infra** (core, data-access-db, queue,
   events, authz, quota, testing — dùng chung, không nghiệp vụ) ≠
   **business feature** (`feature-*`). Không đổi tên folder, phân biệt bằng
   type tags + doc.

Worker/API dùng chung libs; worker không HTTP, api không consumer.

**Mở rộng không rename:** sản phẩm mới = scope mới (`apps/crm/*`); FE mới
(`apps/landing/web`, Nuxt được); service Go (`apps/billing/api` +
api-client-billing); tách auth → `platform/auth` (better-auth standalone,
services verify qua shared session/JWKS); gateway khi ≥2 backend; scheduler
tách entry khi cần. Tất cả là đường lắp đã thiết kế, ghi upgrades.md.

## 5. API Contract (xương sống)

**5.1 Code-first:** Zod DTO + decorator (**`@nestjs/swagger`** — chính là
"Swagger" của hệ thống, sinh OpenAPI từ code) → `openapi.json` (artifact,
commit). Docs UI: **Scalar** đọc openapi.json (thay Swagger UI — hiện đại
hơn, cùng chuẩn OpenAPI).
Chuỗi Nx target: `core-api:openapi → api-client-core:generate → core-web:build`
(dependsOn, cached, affected). Cấm sửa tay spec/client.

**5.2 Drift check CI:** regenerate + `git diff --exit-code`.

**5.3 Lỗi — RFC 9457** `application/problem+json`: type, title, status,
detail, instance + `errors[]` (Zod) + `traceId` (OTel). Một filter duy nhất
trong `core`. 429 kèm Retry-After.

**5.4 Versioning:** URI `/api/v1`; additive không bump; breaking → v2 song song.

**5.5 Response standards:** GET → object trần; list → `{items, nextCursor}`
(cursor opaque: base64url {sortKey, filterHash, direction}; UUIDv7
tie-breaker; offset+total chỉ cho bảng nhỏ per-endpoint); POST → 201 +
Location (trỏ resource vừa tạo); PATCH → 200 (409 nếu stale write theo
optimistic concurrency 6.17); DELETE → 204 (**idempotent:
DELETE lại resource đã xóa vẫn 204**, không 404); async → 202 + {jobId} +
Location trỏ **job status resource** `/api/v1/jobs/{jobId}` (không phải
resource cuối — resource cuối nằm trong kết quả job); list rỗng = [];
camelCase; ISO-8601 UTC; id UUIDv7.

**Idempotency (durable — Redis không phải source of truth):** bảng
`idempotency_records` với **scope model** (không nhét semantics vào
tenant_id nullable — Postgres coi NULL ≠ NULL trong UNIQUE nên composite
chứa tenant_id nullable sẽ lọt duplicate cho B2C):

```
scope_type: ORG | USER | API_KEY | SYSTEM
scope_id, route, idempotency_key
UNIQUE(scope_type, scope_id, route, idempotency_key)   -- mọi cột NOT NULL
state: PROCESSING | COMPLETED | FAILED
request_hash, response_status, response_body
started_at, lease_until, fence_token
```

**Concurrency + lease contract:** A reserve key (INSERT → PROCESSING,
fence_token=1, lease_until=now+lease); B cùng key khi A PROCESSING và lease
còn hạn → **409** + Retry-After; A COMPLETED → B nhận replay; trùng key khác
`request_hash` (method + normalized route + canonical body) → 422.
**Reclaim là lease + fencing, không phải timeout ngây thơ:** `lease_until`
quá hạn chỉ cho phép *recovery attempt* — KHÔNG chứng minh A đã chết. B
reclaim bằng conditional update (chỉ khi lease hết hạn) và nhận
`fence_token+1`; mọi ghi COMPLETED phải prove đúng fence_token của mình —
A "zombie" quay lại commit với token cũ → bị từ chối. Handler dài phải
renew lease (heartbeat). Redis chỉ accelerate; DB constraint là chốt cuối.

**Retention (bảng này phình rất nhanh nếu không dọn):** thêm cột
`completed_at` + index trên nó; COMPLETED giữ 24–72h (configurable), FAILED
giữ 12h, PROCESSING stale xử lý qua lease reclaim (không xóa); worker
cleanup chạy hàng ngày, **delete theo batch** (không DELETE một phát triệu
rows).

**Replay/failure contract (client-facing — mọi endpoint hành xử như nhau):**
chỉ áp dụng cho **mutation non-streaming**; replay trả lại đúng
`response_status` + body + **allowlist header** (Content-Type, Location) —
không replay header khác; `response_body` có **max bytes** (vượt → không lưu
body, replay trả 409 kèm hướng dẫn gọi GET resource); **cấm lưu
secret/PII nhạy cảm trong body đã lưu**; `FAILED` = lỗi business terminal —
retry cùng key trả lại đúng lỗi cũ (muốn thử lại thật phải đổi key); với
**202 async**: record giữ đến khi COMPLETED với body `{jobId}` — replay trả
lại jobId, trạng thái job hỏi qua `/jobs/{id}`.

**5.6 Auth routes:** better-auth tự quản `/api/auth/*`; còn lại khai báo
securityScheme (session cookie / bearer / **api-key**).

**5.7 Polyglot:** service mới nhả openapi.json cùng bộ quy ước; mỗi service
một `api-client-<service>`.

## 6. Kiến trúc dịch vụ nền

### 6.1 Queue, Worker, Scheduling
API enqueue → Redis → core-worker. BullMQ Job Schedulers (upsert idempotent;
đăng ký ở worker vì cohesion — lịch + handler cùng module; BullMQ không có
process scheduler riêng, lịch là state trong Redis). Cấm @nestjs/schedule cho
job nghiệp vụ. Facade `queue` = nơi duy nhất import bullmq; swap
pg-boss/RabbitMQ = đổi ruột lib. Job: retry/backoff, DLQ, idempotent.
Graceful drain khi SIGTERM.

**Job envelope (contract — trace + tenant xuyên queue):** mọi job payload
bọc trong `{ jobId, schemaVersion, traceparent (W3C), tenantId, actorId,
requestedAt, attempt, payload }` — facade `queue` tự inject khi enqueue;
worker **extract traceparent nối OTel span + set tenant context TRƯỚC
handler**. Per-job-type khai báo: timeout/deadline, max attempts, phân loại
lỗi retryable vs terminal, max payload size. **Payload CẤM chứa
credential/secret/PII nhạy cảm** (truyền id, worker tự load). **DLQ replay
là thao tác có quyền**: qua authz + ghi audit, không phải nút bấm tự do.
Không có contract này thì trace api→queue→worker đứt đôi và DoD Phase 6
fail dù OTel cài đúng.

### 6.2 Storage
`STORAGE_DRIVER=s3|local` qua DI. 3 dạng ký: Presigned PUT / Presigned POST
policy (browser) / Multipart (file lớn). Local driver upload streaming qua
API bằng `@fastify/multipart`. **State machine File record:** `pending →
uploaded → scanning → ready | rejected | quarantined` — `rejected`
(content-type thật ≠ khai báo, quá size) và `quarantined` (scanner nghi
ngờ; chỉ admin thao tác tiếp) là terminal có lý do lưu kèm; scan timeout →
retry có giới hạn rồi quarantined. Transition owner: chỉ worker đổi state
(API chỉ tạo pending + nhận complete). `StorageScanner` là interface;
default = no-op pass-through (ghi upgrades.md). Object key thuộc quyền sở
hữu File record — cleanup mồ côi chỉ xóa object không có record HOẶC record
pending quá hạn (không đụng ready). Verify HEAD; signed URL đọc phải qua
authz. MinIO dev.

### 6.3 Realtime
SSE (one-way; stateless; Redis Pub/Sub fan-out) + Socket.IO + redis-adapter
(two-way; websocket-only khi multi-instance). Event contract Zod tập trung;
handshake verify session.

**Đường đi qua edge (Next KHÔNG proxy được realtime):** Next rewrites không
hỗ trợ WebSocket và SSE qua đó dễ dính buffering. Định tuyến chuẩn: **edge
reverse proxy (Caddy)** — `/realtime/*` (WS + SSE) route THẲNG vào core-api
(disable buffering), phần còn lại vào Next. Browser vẫn chỉ thấy MỘT origin
công khai (nguyên tắc "backend URL server-only" giữ nguyên — cái browser
không thấy là internal URL, không phải là không có đường realtime). Dev
local: FE nối thẳng localhost:3000 cho realtime — chấp nhận, ghi rõ trong
doc.

### 6.4 GraphQL — add-on, không mặc định (upgrades.md).

### 6.5 Multi-tenancy, Tenant Settings & Authz
Tenant = organization; B2C = không active org. Cách ly 2 lớp: Prisma
Extension inject orgId (AsyncLocalStorage) + **RLS ENABLE+FORCE** với
`set_config(..., true)` theo transaction (PgBouncer transaction-mode OK —
test P3); `app_user` không BYPASSRLS; migration role riêng; admin
cross-tenant connection riêng.

**Read path (điểm dễ vỡ nhất — tường minh):** với RLS FORCE, **MỌI query
tenant-scoped — kể cả SELECT đơn thuần — phải chạy trong transaction có
`set_config`**, nếu không DB trả rỗng âm thầm. Query tenant-scoped khi
**thiếu tenant context → THROW lỗi rõ** ("no tenant context"), tuyệt đối
không âm thầm trả rỗng — fail loud. Test bắt buộc: query trần không context
phải bị chặn (mục 8).

**Transaction ownership (chốt MỘT mô hình — extension KHÔNG quản
transaction):**

- **`withTenantTransaction(async (tx) => ...)`** là owner DUY NHẤT của
  transaction + GUC (set CẢ `app.current_org_id` lẫn `app.current_user_id`):
  mọi tenant-scoped read/write + mọi outbox write chạy trên `tx`. Tên hàm
  này là chuẩn duy nhất toàn spec — không có biến thể tên khác.
- **`withSystemTransaction(...)`** cho thao tác GLOBAL/SYSTEM (relay, jobs
  hệ thống) — tách bạch, không set tenant GUC.
- `TenantContext = tenant(org) | user-only(B2C) | system` — khai báo tường
  minh, quyết định GUC nào được set.
- **Prisma Client Extension KHÔNG mở transaction, không auto-wrap** — nó chỉ
  guard: chặn query tenant-scoped chạy ngoài tenant context (THROW). Lý do:
  Prisma cảnh báo extension gọi client khác bên trong transaction có thể
  chạy trên connection MỚI và bỏ qua transaction hiện tại — magic auto-wrap
  là chỗ invariant security bị gãy âm thầm.
- Read tiện lợi đi qua accessor **`db.tenant()`** (request-scoped, CLS-bound
  trong data-access-db): trả về đúng transaction client đang active, hoặc tự
  mở transaction NGẮN qua chính withTenantTransaction — một điểm hiện thực
  duy nhất, không phải magic của extension.
- **Runtime enforcement (không chỉ convention):** root PrismaClient là
  **private trong data-access-db** — không export; API duy nhất ra ngoài là
  `db.tenant()` / `db.system()`. ESLint rule cấm import root client ngoài
  data-access-db. Trong integration test, root client được thay bằng
  **proxy ném lỗi** khi có transaction active — invariant được test bằng
  máy, không tin CLS suông. Interactive transaction giữ NGẮN — cấm network
  call/công việc chậm bên trong callback.
**Switch workspace** = đổi active org (UI org switcher). **Invite member** qua organizations plugin + seat check (6.7).
**Tenant Settings**: bảng `org_settings` key-value validate bằng Zod schema
per-key + UI; chứa IP whitelist, webhook endpoints config, flags override...

**Source of truth chain (chốt chính thức):** Application tenant context →
Prisma Extension (giúp dev viết đúng) → **PostgreSQL RLS = security boundary
CUỐI CÙNG** (bảo vệ cả khi application code sai).

**Phân loại bảng (convention cho generator + migration — policy viết sẵn
từng loại, generator KHÔNG tự suy diễn):**

- `GLOBAL` — dữ liệu dùng chung thật sự (plans, flag definitions). Không RLS
  tenant.
- `TENANT_OWNED` — `org_id NOT NULL` + RLS FORCE, policy
  `org_id = current_setting('app.current_org_id')::uuid`.
- `TENANT_OPTIONAL` — org_id nullable (dữ liệu B2C không thuộc org).
  **CẤM policy ngây thơ `org_id IS NULL OR org_id = ...`** (mọi tenant sẽ
  thấy toàn bộ row null). Row `org_id IS NULL` bắt buộc có isolation key
  khác: policy chuẩn
  `(org_id = current_setting('app.current_org_id')::uuid) OR (org_id IS NULL
  AND user_id = current_setting('app.current_user_id')::uuid)` — tức
  withTenantTransaction set CẢ HAI GUC (org + user).
- `SYSTEM` — outbox, audit_logs, idempotency_records, quota_reservations,
  migrations: `app_user` chỉ có đúng quyền tối thiểu từng bảng (INSERT-only,
  hoặc qua function), không đọc/tùy tiện.

**Ma trận tenant context ↔ GUC ↔ policy (SQL mẫu dùng chung — chi tiết đầy
đủ trong `docs/contracts/tenant-context.md`):**

| Context | GUC được set | Đọc được |
|---|---|---|
| `ORG` | `app.current_org_id` + `app.current_user_id` | TENANT_OWNED của org + TENANT_OPTIONAL của org + GLOBAL |
| `USER_ONLY` (B2C) | CHỈ `app.current_user_id` (KHÔNG set org GUC) | TENANT_OPTIONAL có `org_id IS NULL AND user_id = mình` + GLOBAL |
| `SYSTEM` | không GUC tenant — đi qua role riêng (6.17), không qua policy tenant | theo GRANT của role |

Policy mẫu phải chịu được GUC **không được set** (dùng tham số `missing_ok`
+ `NULLIF` để không nổ cast từ chuỗi rỗng):

```sql
CREATE POLICY tenant_isolation ON "Item" USING (
  org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  OR (org_id IS NULL
      AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
);
```

(Nhánh `org_id IS NULL` CHỈ tồn tại trên bảng TENANT_OPTIONAL; bảng
TENANT_OWNED chỉ có nhánh đầu.) Mỗi bảng khai báo có cho phép USER_ONLY hay
không — generator hỏi tường minh.

**Authz facade** (`libs/core/server/authz`) — contract hoàn chỉnh, không chỉ
một hàm:

```typescript
type AuthorizationContext = {
  orgId?: string;
  resourceId?: string;
  resourceOwnerId?: string;
  attributes?: Record<string, unknown>;
};
authz.can(user, action, resource, ctx): Promise<boolean>
authz.require(user, action, resource, ctx): Promise<void>  // deny → throw 403 Problem Details chuẩn
authz.canAny(user, actions[], resource, ctx) / authz.canAll(...)
```

Business code dùng `require()` — cấm tự lặp `if (!can) throw`; mọi permission
denial đi qua một semantic chuẩn (đếm được, audit được). Ruột hôm nay:
better-auth AC (RBAC per-org + dynamic roles — bậc 3) + ABAC-lite
(ownership, attribute conditions).

**Policy contract (không chỉ API):**

- **Vocabulary:** action đặt tên `"<resource>.<verb>"` (`invoice.read`,
  `invoice.approve`) — registry tập trung, typed, trùng với permission
  statements của better-auth AC.
- **Default DENY:** resource/action không có trong registry hoặc policy
  không tồn tại → **deny**, không bao giờ allow ngầm.
- **Principal:** context phân biệt `principalType: "user" | "apiKey" |
  "system"` — API key thuộc org KHÔNG đại diện một user, đi theo permissions
  của chính key (không vượt quyền người phát hành — 6.14).
- **Impersonation:** tách `actor` (admin thật) ≠ `effectiveUser` (người bị
  impersonate) trong context — authz check theo effectiveUser, audit ghi CẢ
  HAI.
- **ActionRegistry là artifact có version:** schema typed (resource, verbs,
  mô tả), policy version tăng khi đổi; đổi policy → invalidate cache theo
  version (cùng cơ chế 6.12); mỗi deny sinh **deny reason nội bộ** (log +
  audit event, KHÔNG trả chi tiết cho client — client chỉ nhận 403 chuẩn).
- **API key không fallback session:** route opt-in api-key mà key
  invalid/thiếu → 401 luôn, không thử tiếp session auth. Bậc 5 ReBAC (OpenFGA/SpiceDB) = provider cắm sau facade, sync
tuples qua domain events — ghi upgrades.md kèm tín hiệu (hierarchy sâu, ủy
quyền, share theo quan hệ). Admin hệ thống + impersonation (audit + banner).

### 6.6 Audit log
Consumer domain events (mutation, login, invite, role change, impersonation)
→ `audit_logs` append-only (REVOKE UPDATE/DELETE với `app_user`); actor,
orgId, action, resource, diff, ip/UA, traceId.

**Carve-out cho GDPR (giải mâu thuẫn với 6.9):** audit tối thiểu hóa PII —
actor lưu bằng id (pseudonymous), KHÔNG lưu email/tên trong record. Các cột
PII còn lại (ip, user_agent, diff) được anonymize bởi erasure job chạy qua
**role `erasure_role` riêng** có `GRANT UPDATE (ip, user_agent, diff)` đúng
3 cột đó — `app_user` vẫn bị REVOKE hoàn toàn; append-only với ứng dụng
không đổi, chỉ erasure job (connection riêng, chỉ worker) được sửa đúng
phần PII.

### 6.7 Entitlements & Quota Engine

**Quota engine là platform-infra** (`libs/core/server/quota` — nhiều feature
dùng, không phải business feature). Semantics đầy đủ, không chỉ atomic:

- **Hai class quota — chọn semantics tường minh, không mập mờ (Redis và DB
  không có transaction chung nên không thể vừa nhanh vừa strict):**
  - **STRICT** (billing/entitlement nghiêm ngặt — mặc định cho credits,
    seats): **DB là enforcement authority.** Reservation atomic NGAY TRONG
    `withTenantTransaction` cùng nghiệp vụ (`UPDATE ... SET used = used + n
    WHERE used + n <= limit` / bảng `quota_reservations` với state machine
    `reserved → committed | released | expired`, expires_at) — business
    side-effect và trừ quota commit hoặc rollback CÙNG NHAU, không có
    crash-window. Redis chỉ là cache đọc (hiển thị usage, pre-check giảm
    load) — không quyết định.
  - **FAST** (soft limit tần suất cao — rate-limit, chống spam): **Redis là
    enforcement authority** (Lua atomic), DB usage events là durable
    accounting để đối soát — chấp nhận sai số nhỏ khi Redis sự cố, và gọi
    đúng tên: DB ở class này là ledger kế toán, KHÔNG phải enforcement.
- **Lifecycle (STRICT):** `consume` một bước hoặc `reserve → commit |
  release` cho job dài (reserve 10 credits → job chạy → success: commit /
  failure: release; quá expires_at → expired + trả quota); `refund` cho
  nghiệp vụ hoàn trả.
- **Window khai báo per-entitlement:** `fixed-window | sliding-window |
  daily | monthly | lifetime`.
- **Recovery:** STRICT rebuild cache từ DB; FAST đối soát counter ↔ usage
  events, sai số ghi nhận chứ không "sửa lịch sử".
- **Canonical data model (chốt MỘT, không để hai lựa chọn mở):** consume
  một-bước dùng **counter ledger** (`org_quota_counters`:
  UNIQUE(org_id, entitlement, window_start), UPDATE có điều kiện); job dài
  dùng **reservations** (`quota_reservations`). Lock order cố định:
  counter trước, reservation sau (chống deadlock); isolation READ COMMITTED
  đủ vì UPDATE có điều kiện; sweeper định kỳ expire reservation quá hạn;
  `refund` idempotent theo reservation_id.
- Vượt quota → 403/429 Problem Details type riêng (FE hiển thị upsell).

**feature-entitlements** (business feature) giữ: bảng plans +
org_entitlements, guard `requireEntitlement` (gọi quota infra), hook
`onPlanChanged`, seat limit khi mời member, UI.

### 6.8 Webhook Engine
Per-org endpoints + secret; **signature HMAC-SHA256** (X-Signature +
timestamp chống replay); **retry** backoff qua queue; **DLQ**; **delivery
logs** (bảng webhook_deliveries + UI). Consumer của domain events.

**Chống SSRF đầy đủ (không chỉ validate string URL):** validate URL →
**resolve DNS → validate IP đã resolve** (chặn private/link-local/metadata,
CẢ dải IPv6 private) → **connect bằng đúng IP đã validate** (pin — chống
DNS rebinding giữa validate và request) → **disable redirects** (hoặc
validate lại từng hop); HTTPS-only prod.

### 6.9 Delete & GDPR
Hard delete mặc định; User/Org: soft delete + grace 30 ngày → worker erasure
(xóa thật + anonymize audit **qua `erasure_role` với column-level UPDATE
grant — cơ chế carve-out ở 6.6**). Doc ứng xử unique/FK.

### 6.10 Domain events & Outbox
`publishEvent()` ghi bảng outbox **cùng transaction** với data → relay ở
worker phát vào BullMQ → consumers (webhooks, audit, usage, search-sync).

**Schema outbox (contract):** `event_id (UUIDv7)`, `aggregate_type`,
`aggregate_id`, `aggregate_version` (**lấy từ cột `version` của aggregate
sau optimistic-concurrency update — 6.17**; tăng dần per-aggregate — nền cho
per-aggregate ordering sau này và cho consumer phát hiện out-of-order),
`event_type`, `payload (jsonb)`, `occurred_at`, `enqueued_at`,
`status (PENDING | PROCESSING | ENQUEUED | DEAD)`, `locked_at`,
`last_error`, `attempts`, `available_at`. Bảng loại SYSTEM (6.5).
(**ENQUEUED, không phải "PUBLISHED"** — trạng thái này chỉ nói "relay đã đưa
vào BullMQ", KHÔNG nói consumer đã nhận/xử lý.)

**Delivery semantics (relay chạy được N replica):** relay claim batch bằng
`SELECT ... FOR UPDATE SKIP LOCKED WHERE status='PENDING' AND available_at
<= now()` → PROCESSING + locked_at → phát BullMQ → ENQUEUED. Fail →
attempts++, available_at = now + backoff mũ; vượt max attempts → **DEAD**
(poison event — alert, xử lý tay, không chặn hàng đợi). PROCESSING có
locked_at quá stale-timeout (relay chết giữa chừng) → reclaim về PENDING.

**Replay contract (ENQUEUED không phải terminal):** outbox DB giữ event
replay được trong N ngày retention; dispatch vào queue là **at-least-once**
— khi Redis/queue mất dữ liệu, record ENQUEUED trong retention được phép
replay (đưa về PENDING theo khoảng thời gian sự cố). Hết retention mới
xóa/archive (job cleanup).

**Consumer dedup (biến "consumer phải idempotent" từ nguyên tắc thành cơ
chế):** relay enqueue với **BullMQ `jobId = event_id`** (dedup lớp queue —
crash giữa enqueue và update DB → enqueue lại cùng jobId bị BullMQ bỏ qua);
mỗi consumer ghi bảng inbox `processed_events` với
**UNIQUE(consumer_name, event_id)** — xử lý xong INSERT trong cùng
transaction với side-effect; gặp duplicate → skip. Webhook cụ thể:
`webhook_deliveries` có **UNIQUE(endpoint_id, event_id)** — một event chỉ
một delivery record per endpoint, retry bám vào record đó chứ không tạo mới.
At-least-once → consumer idempotent. **Không đảm bảo ordering** — consumer
không được phụ thuộc thứ tự event (với webhook/audit, at-least-once +
idempotent là đủ); per-aggregate ordering (partition theo aggregate id) là
nâng cấp khi có consumer thật sự cần, ghi upgrades.md. **Kafka graduation**: KIP-932 GA từ
Kafka 4.2 (dùng 4.2.1+), nhưng thiếu DLQ/backoff/ordering — chưa thay job
queue; khi cần multi-service streaming/replay/polyglot: đổi mỗi relay
(hoặc CDC/Debezium), feature code không đổi. Ghi upgrades.md.

### 6.11 Search
PG FTS + pg_trgm (tsvector generated + GIN) demo. Thang: Meili/Typesense
(typo/facets/<50ms/CJK) → Elastic/OpenSearch (log analytics, tỷ docs; lưu ý
license ELv2). Sync qua domain events. Ghi upgrades.md.

### 6.12 Feature Flags
**OpenFeature SDK** (chuẩn CNCF — bản thân nó là facade) + provider in-house:
flags theo env + org-scoped trong DB (org_settings) + cache Redis; evaluate
server-side, expose cho FE qua API. Swap Unleash/Flagsmith/GrowthBook = đổi
provider, call sites không đổi. Ghi upgrades.md.

**Invalidation (yêu cầu "đổi flag không redeploy" phải nhất quán giữa
instances):** flag đổi → ghi DB → publish Redis Pub/Sub invalidate →
instances reload; kèm versioned cache key (`flags:v{n}`) làm cơ chế phụ.
**Chống message reorder:** payload invalidate chứa `version` integer tăng
dần — instance chỉ apply khi `incoming.version > local.version` (v3 tới
trước v2 thì v2 bị bỏ qua — deterministic). Không dựa vào TTL cache
per-process (các instance lệch nhau trong cửa sổ TTL).

### 6.13 AI-Ready Layer
`feature-ai`: **Vercel AI SDK v7** — provider-agnostic (Anthropic/OpenAI/
local qua một interface; đổi model = config); **pgvector** trên PG18
(Prisma `Unsupported("vector")` + `$queryRaw` similarity); embeddings util
(embed/embedMany); **streaming** trả lời qua SSE (6.3 có sẵn); AI task dài
chạy qua queue (6.1) với progress qua realtime; **token usage → usage events**
(6.7) để metering/quota theo org; RAG demo endpoint (ingest → embed → search
→ answer). Không chọn vendor model — đó là config của dự án.

**Governance (facade `ai.generate`, feature code không gọi provider trực
tiếp):** mọi call khai báo `purpose` + `model` là **alias policy**
(`fast`/`smart` → map sang model thật trong config); tự động ghi kèm: AI
request id, prompt version, input/output tokens, provider latency,
estimated cost → usage events (6.7); `safetyPolicy` hook cho project cần
lọc nội dung.

### 6.14 Security Layer (checklist enterprise)
Helmet (`@fastify/helmet`); CORS tường minh theo env; **CSRF**: better-auth tự bảo vệ
`/api/auth/*`, API còn lại dùng SameSite=Lax + origin-check middleware
(double-submit không cần khi origin-check đủ — ghi ADR); rate limit
throttler + Redis (per-user/org/IP/api-key); **IP whitelist per-org** (guard
đọc org_settings); **device sessions** (multi-session plugin: list/revoke
thiết bị, UI); refresh rotation (better-auth); Idempotency-Key; **API keys**
(@better-auth/api-key: per-org, rate-limit per-key, Redis storage option;
digest SHA-256 at rest; **scope của key không vượt quyền người phát hành**;
route nhận api-key phải opt-in tường minh; **lifecycle:** mỗi key có `name`,
`prefix` hiển thị (nhận diện key mà không lộ secret), `created_at`,
`expires_at` nullable, `revoked_at`; **rotation = tạo key mới TRƯỚC →
client migrate → revoke key cũ SAU** — không bao giờ revoke-rồi-tạo);
webhook signature (6.8); redact secrets trong log; pnpm audit trong CI
(lớp redundant có chủ đích cạnh OSV-Scanner — rẻ, chạy sớm nhất).

### 6.15 Observability
**Pino** (JSON stdout, redact) + **Request ID** (per-request, trả trong
header) + **Trace ID** (OTel — nối vào ProblemDetails, pino, audit) +
**OpenTelemetry** (nestjs-otel: traces + metrics OTLP) + **Prometheus**
`/metrics` (OTel prom exporter) + **Grafana + Loki** — dev compose dùng
`grafana/otel-lgtm` (Grafana+Loki+Tempo+Prometheus trong 1 container).
Prod: trỏ OTLP endpoint bất kỳ (trung lập vendor). `@nestjs/observe` = tùy
chọn SaaS, ghi doc.

**Metric contract (tên chốt sẵn, không tùy hứng):** `http_request_duration`
+ error rate, `queue_depth`/`queue_lag`, `job_retries`/`job_dlq_total`,
`outbox_pending`/`outbox_processing`/`outbox_dead`,
`idempotency_conflicts`/`idempotency_replays`, `quota_rejections`,
`webhook_delivery_{success,failure}`, `storage_scan_results`, `backup_age`.
**Cardinality budget:** label KHÔNG chứa userId/orgId/URL đầy đủ — chỉ
route pattern, status class, job type, consumer name.

### 6.16 Kiến trúc bên trong service

**`core-api`** — NestJS modular, mỗi `feature-*` lib = một Nest module trọn
vẹn; phân tầng nhẹ, KHÔNG hexagonal đầy đủ (đã chốt: boundary bằng Nx lib,
không interface repository hình thức — cô lập nằm ở ESLint boundary).

```
Request (Fastify)
├─ Guards/Middleware: auth (session/api-key) → tenant context (ALS orgId)
│                     → throttler → IP whitelist
├─ Pipe: nestjs-zod validate ──lỗi──► 400 Problem Details (errors[])
├─ Controller (mỏng: DTO in/out + OpenAPI decorators)
├─ Service (business logic):
│    authz.can(...)                       # một cửa duy nhất
│    withTenantTransaction(tx => {        # owner transaction duy nhất
│      set_config org_id (RLS tự động)
│      ...data-access-db...               # Prisma nhốt ở đó
│      publishEvent(...)                  # outbox CÙNG transaction
│    })
└─ Exception filter (duy nhất, ở core) ──► RFC 9457 + traceId
```

**`core-worker`** — không HTTP; bootstrap đăng ký consumers + Job Schedulers
+ outbox relay; handler gọi CÙNG service/data-access libs với API (logic
không viết hai lần); tenant context set từ payload job.

**`core-web`** — Next App Router server-first: `proxy.ts` (route protection,
backend URL server-only) → `app/[locale]` (next-intl, RSC mặc định) →
Client Components chỉ khi tương tác (TanStack Query cho server state; RHF +
zodResolver tái dùng Zod schema contract); UI ghép từ `shared/ui` +
`core/web`. Không state manager toàn cục (chủ đích — ghi upgrades).

**Nguyên tắc xuyên suốt:** mọi "một-cửa-duy-nhất" (transaction, authz, error
format, event publish, queue, flags) là hàm bắt buộc đi qua, được
boundary/lint ép — kiến trúc giữ hình dạng khi nhiều người cùng code.

### 6.17 Migration strategy (Prisma Migrate)

**Vòng đời:** dev dùng `prisma migrate dev`; production dùng `prisma migrate
deploy` chạy trong **entry migration riêng** (Phase 6) — chạy TRƯỚC app trong
pipeline/compose (`depends_on`). **Cấm app tự migrate lúc boot** — N replicas
cùng boot là N lần đua migrate.

**Custom SQL** (thứ Prisma schema không biểu diễn được — RLS policy, CHECK,
REVOKE, GIN/tsvector, pgvector, `EXCLUDE`): `prisma migrate dev
--create-only` → viết thêm SQL vào file migration → vẫn nằm trong lịch sử
Prisma quản lý. Viết SQL trong migration KHÔNG vi phạm ràng buộc 2 — đây là
chỗ duy nhất không có công cụ nào thay thế, và Database Workflow yêu cầu đẩy
invariant xuống DB.

**Zero-downtime:** expand → backfill → contract; thay đổi destructive
(DROP/RENAME) không đi cùng release với code còn dùng nó; nêu lock impact
cho ALTER trên bảng lớn; index trên bảng sống dùng `CREATE INDEX
CONCURRENTLY` (chạy ngoài transaction — tách file migration riêng).

**Rollback:** mỗi migration kèm **rollback script đã test** (sinh khung bằng
`prisma migrate diff` theo chiều ngược, chỉnh tay phần data); triết lý chính
là roll-forward, rollback script là phao khi release hỏng — test rollback
trong CI trên Testcontainers (up → down → up phải sạch).

**CI:** (1) apply toàn bộ migrations vào Postgres Testcontainers từ zero;
(2) **drift check**: `prisma migrate diff` giữa schema.prisma và DB sau
migrate — lệch là fail (migration bị sửa tay sau khi merge sẽ bị bắt);
(3) test up→down→up.

**Role model (5 role — mỗi role có GRANT/REVOKE tường minh, cross-tenant là
explicit role chứ không phải "system context" chung):**

| Role | Dùng bởi | Quyền |
|---|---|---|
| `app_user` | core-api | CRUD bảng nghiệp vụ qua RLS; SYSTEM tables: quyền tối thiểu (outbox INSERT, idempotency INSERT/UPDATE-lease, audit INSERT-only) |
| `worker_user` | core-worker | như app_user + đọc/claim outbox (SKIP LOCKED), quota sweeper, cleanup |
| `erasure_role` | erasure job | UPDATE column-level (ip, user_agent, diff) trên audit_logs + DELETE User/Org theo procedure |
| `migration_role` | entry migration | BYPASSRLS, DDL |
| `cross_tenant_admin_role` | thao tác admin nội bộ | BYPASSRLS đọc — connection string riêng, MỌI lần dùng ghi audit; không bao giờ dùng trong request path thường |

Seed tách khỏi migration (chỉ dev/test; prod seed per-project).

**Optimistic concurrency (bắt buộc cho aggregate mutable — mảnh còn thiếu
để `aggregate_version` của outbox có ý nghĩa):** aggregate mutable có cột
`version INT NOT NULL DEFAULT 1`; UPDATE luôn kèm điều kiện
`WHERE id = ? AND version = expectedVersion`, thành công thì
`version = version + 1`; **0 rows affected → 409 Conflict** (stale write,
Problem Details type riêng — client re-read rồi retry). `aggregate_version`
ghi vào outbox (6.10) lấy từ version MỚI sau update. Không có cột version
thì hai PATCH đồng thời cùng đọc v3 → cả hai ghi đè → lost update mà không
ai biết.

### 6.18 Routing contract (edge — MỘT bảng duy nhất, hết mâu thuẫn Next vs Caddy)

**Caddy là edge duy nhất** của production; Next proxy chỉ là server-side BFF
cho các route đã chọn — rewrites KHÔNG phải security boundary.

| Public path | Upstream | Auth layer | Buffering | WebSocket |
|---|---|---|---|---|
| `/api/auth/*` | core-api (trực tiếp) | better-auth | on | — |
| `/api/*` | core-api (trực tiếp) | session/api-key guard | on | — |
| `/realtime/sse/*` | core-api | session | **OFF** (flush ngay) | — |
| `/realtime/ws` | core-api | handshake session | — | **on** |
| `/docs` (Scalar từ openapi.json) | core-api | dev: mở; prod: tắt hoặc sau auth (env) | on | — |
| `/health` | core-api (terminus) | none | on | — |
| `/metrics` | core-api | **chặn public — chỉ internal network** | on | — |
| còn lại | core-web (Next) | proxy.ts route protection | on | — |

Dev local: FE gọi thẳng localhost:3000 (ghi doc). Chi tiết đầy đủ + timeout
per-route: `docs/contracts/routing.md`.

### 6.19 Contract artifacts bắt buộc (máy enforce được, không chỉ prose)

| Artifact | Nội dung | Giao ở |
|---|---|---|
| `docs/contracts/tenant-context.md` | Ma trận context/GUC/role/policy SQL + Mermaid | P3 |
| `docs/contracts/problem-details.md` | Error type registry + mapping | P2 |
| `docs/contracts/routing.md` | Bảng 6.18 + timeout per-route | P2 (Caddy dev) / P6 (prod) |
| `docs/contracts/idempotency.md` | Scope, fingerprint, lease/fence, replay + Mermaid state | P2 |
| `docs/contracts/job-envelope.md` | Schema version, retry, timeout, PII rule | P4 |
| `docs/contracts/outbox.md` | State machine Mermaid, relay recovery, dedup, replay | P4 |
| `docs/contracts/quota.md` | STRICT/FAST API, reservation lifecycle Mermaid | P4 |
| `docs/security/threat-model.md` | SSRF, CSRF, session, api-key, impersonation, RLS | P3 |
| `docs/ops/slo.md` + `docs/ops/production.md` | SLO, metric contract, runbook | P6 |
| `docs/sources.md` | Bảng evidence (mục 12) | P1 |
| ADR per spike/exception | Quyết định + owner | mọi phase |

Mỗi state machine trong contracts: state hợp lệ, transition owner,
retryability, terminal states, idempotency key, metric/alert tương ứng.

## 7. Các phase

### Phase 1 — Nền tảng
create-nx-workspace (ts, pnpm) → @nx/nest + apps/core/api (**chuyển
FastifyAdapter**) → @nx/next + apps/core/web → @nx/vitest → libs vỏ
(shared/ui, api-client-core) → tags + boundaries → **Nx local plugin
`tools/` + generator `feature-lib`/`product-scope`** → pnpm catalogs →
**Lefthook** + commitlint + gitleaks pre-push + nx release → Renovate +
knip → ADR-0001 + khung upgrades.md
(ràng buộc 7) → **one-command onboarding** (`pnpm i && pnpm dev` kéo compose
+ migrate + seed + chạy đủ stack) → compose dev (PG18, Redis, Mailpit,
MinIO, otel-lgtm) → shadcn init + MCP → ci-workflow (+ **bước security:
Gitleaks, OSV-Scanner, Semgrep** trong CI) → TS7 dual-install
(bước riêng + benchmark). **DoD:** run-many xanh; dev mới clone → một lệnh
chạy được toàn stack.

### Phase 2 — Backend core + contract
**Spike de-risk better-auth + Fastify (nửa ngày, làm ĐẦU phase):** mount
better-auth trên Fastify adapter + 1 route bảo vệ chạy được; chốt lib tích
hợp (candidates ở mục 9) hoặc kích hoạt đường lui: mount như Fastify plugin
thuần / tách `platform/auth` chạy Express riêng. **ADR spike bắt buộc ghi:**
package + version chốt, adapter, cookie/session behavior sau Caddy
(X-Forwarded-*), CSRF behavior, hỗ trợ organizations/api-key/impersonation,
test matrix đã chạy; nếu fail → quyết định fallback NGAY + cập nhật
tree/phase. Phase 3 không được bắt đầu trên một dấu hỏi. →
Prisma init (UUIDv7, TIMESTAMPTZ) → core lib (Zod env, pino, filter,
terminus, throttler+Redis, Idempotency-Key, helmet/CORS/CSRF origin-check,
distributed lock util) → openapi.json + hey-api + pipeline + drift check →
pagination helpers → quy trình migration đầy đủ theo 6.17 (custom SQL
--create-only, rollback script + test up→down→up, drift check trong CI) →
search demo PG FTS →
**API docs UI (Scalar) serve từ openapi.json** → **test data factories**
(@faker-js/faker + fishery, seed dùng chung) → **transaction helpers**
(`withTenantTransaction` + `withSystemTransaction` qua CLS — cách duy nhất
mở transaction, tương thích RLS set_config; kèm runtime invariant test theo
6.5) → endpoint + component mẫu. **DoD:** đổi DTO vỡ type đúng chỗ; 429/idempotent
replay/CSRF có e2e; gate xanh.

### Phase 3 — Auth, Tenancy, Authz, i18n
better-auth (2FA, organizations, AC + dynamic roles, admin/impersonation,
multi-session, api-key) → tenant context + Prisma Extension + RLS migrations
(+PgBouncer test + EXPLAIN) → **authz facade** → org_settings (+ IP
whitelist guard) → web: auth screens, org switcher, device sessions UI,
**forms chuẩn react-hook-form + zodResolver tái dùng chính Zod schema của
contract** (một schema validate cả FE lẫn BE), **backend URL server-only**
(browser chỉ thấy origin công khai của edge — routing theo đúng bảng 6.18:
`/api/*` và `/api/auth/*` qua Caddy thẳng vào core-api, KHÔNG qua Next
rewrites; **đây là tối ưu topology/exposure, KHÔNG phải security boundary**
— backend vẫn coi mọi request là untrusted và tự authenticate/authorize), next-intl vi/en → user CRUD tenant-scoped. **DoD:** e2e full flow (vi/en);
negative test cách ly 2 lớp; api-key + IP whitelist + impersonation banner
có test; gate xanh. **Phase 3 có 3 exit gate RIÊNG, không cho UI che lấp
nền:** (a) Auth gate — session/api-key/2FA pass test matrix; (b) Tenant/RLS
gate — ma trận context 6.5 + negative tests + PgBouncer + EXPLAIN đạt;
(c) Authz gate — registry + default-deny + principal types có test. Gate
nào chưa xanh thì phần đó chưa xong, dù UI đẹp.

> **🏁 USABLE MILESTONE — sau Phase 3:** nền đã đủ (contract + auth +
> tenancy + authz) để **sản phẩm thật đầu tiên bắt đầu build trên nó**;
> Phase 4–6 chạy song song với sản phẩm. Tiêu chí "đủ tốt để dừng" của
> boilerplate = hết Phase 6 + một sản phẩm thật đang dùng nền — sau đó nền
> chỉ nhận thay đổi phục vụ sản phẩm thật, không đánh bóng vô hạn.

### Phase 4 — Jobs, Events, Quota, Flags, Audit, Webhooks

**Thứ tự bắt buộc trong phase (webhooks/GDPR chỉ sau khi outbox replay +
role model đã kiểm chứng):** queue/envelope → outbox + consumer dedup →
audit → quota → flags → webhooks → GDPR.

queue facade + BullMQ (+ **Bull Board** UI, guard bằng authz, bật theo env)
→ core-worker (drain) → Job Schedulers → events lib
(outbox + relay) → Redis cache → mail qua queue → feature-audit →
feature-entitlements + quota infra (STRICT: DB reservation trong
withTenantTransaction; FAST: Redis Lua; usage events + seat limit) →
feature-flags (OpenFeature + provider in-house) → feature-webhooks (đủ
engine 6.8) → GDPR erasure job. **DoD:** kill worker → retry xong; 2
replicas không trùng cron; crash giữa transaction — outbox vẫn phát; quota
không race dưới concurrent (test song song); flag đổi có hiệu lực không
redeploy; webhook ký/retry/DLQ/SSRF có test; gate xanh.

### Phase 5 — Storage, Realtime, AI
feature-storage (3 dạng ký, cả 2 driver) → feature-realtime (SSE + WS +
redis-adapter; demo progress) → **feature-ai** (AI SDK provider config,
pgvector migration, embeddings util, RAG demo + streaming SSE + usage
events). **DoD:** upload 3 dạng pass cả 2 driver; 2-instance fan-out; RAG
demo trả lời stream + ghi token usage; gate xanh.

### Phase 6 — Observability & Vận hành
OTel đầy đủ (traces+metrics; traceId xuyên ProblemDetails/pino/audit) →
/metrics Prometheus → dashboards Grafana mẫu (doc) → Dockerfile multi-stage
**hardened** (base pin SHA256, non-root UID, tini PID 1, không shell utils;
context tối thiểu qua pnpm deploy/generatePackageJson) → **entry migration
riêng** (`prisma migrate deploy` chạy trước app trong pipeline/compose) →
**Trivy scan image + SBOM + SLSA provenance + Cosign sign** trong release →
@nx/docker + nx release publish → compose prod **có Caddy ingress** (TLS
auto, route `/realtime/*` → core-api không buffering, còn lại → Next; header
X-Forwarded-* chuẩn cho Fastify trustProxy). **DoD:** compose prod đủ
stack (migration chạy trước, app sau); trace một request xuyên
api→queue→worker nhìn thấy trong Tempo; image pass Trivy + có SBOM/SLSA/
chữ ký; nx release --dry-run đúng; gate xanh. Kèm **`docs/ops/production.md`
(operational contract):** firewall (chỉ 80/443 + SSH public; **Postgres/
Redis/MinIO tuyệt đối không expose** — Docker network nội bộ), SSH
hardening, secret injection (env file quyền chặt/secret manager — không
commit), container `restart: unless-stopped` + healthcheck đủ, log rotation
(json-file max-size/max-file), resource limits per-container, disk
monitoring; backup Postgres (pg_dump/WAL theo cron) + mirror MinIO **ra
ngoài máy** + **backup có mã hóa**; baseline **RPO 24h / RTO 4h** (project
override được). **Backup là acceptance test, không phải mục tiêu trên
giấy — DoD Phase 6 gồm:** restore drill (bán) tự động vào môi trường sạch,
ĐO RPO/RTO thực tế so baseline, verify backup usable (checksum + app đọc
được data sau restore, không chỉ "file tồn tại"), thứ tự restore
(PG → MinIO → app), ai được phép restore ghi trong runbook có owner.

### Hạ tầng triển khai — chạy trọn trên 1 VPS

Compose prod là target mặc định (đã chốt từ đầu — không K8s). **Ingress:
Caddy** — TLS tự động (Let's Encrypt), một origin công khai duy nhất, route
`/realtime/*` thẳng vào core-api (6.3), còn lại vào Next; RAM +30–50 MB.
RAM lõi production (Caddy + api + worker + web + PG18 + Redis + MinIO) ≈
**1–2 GB idle→tải nhẹ** — đây là **ước lượng khởi điểm, KHÔNG phải cam
kết**: chưa tính dataset lớn, connection pool, build peak, retention logs.
Phase 6 giao **compose smoke profile đo được** (concurrency + dataset mẫu →
RAM/p95 thực tế) với 3 profile: `dev`, `prod-minimal`, `prod-observability`
— con số thật thay con số giấy.

| Mức | Cấu hình | Ghi chú |
|---|---|---|
| Tối thiểu | 2 vCPU / 4 GB / 40 GB SSD | Tắt otel-lgtm tại chỗ, trỏ OTLP ra Grafana Cloud free; swap 2 GB |
| Khuyến nghị | 4 vCPU / 8 GB / 80 GB SSD | Đủ toàn stack + 2 replicas api/worker (test multi-instance thật) |
| Thoải mái | 8 vCPU / 16 GB | Dư địa pgvector lớn, Meilisearch khi nâng cấp |

Lưu ý trung thực: 1 VPS = SPOF — bắt buộc backup offsite (trên); AI layer
tốn chi phí API ngoài, không tốn VPS; CI chạy GitHub Actions không ăn tài
nguyên máy; các graduation (Kafka/Elastic/tách auth-gateway) mới là lúc cần
thêm máy. HA multi-node ghi upgrades.md.

## 8. Testing & verification

Unit (Vitest, property-based khi xứng đáng) / Integration (**Testcontainers**
— PG+Redis thật, cô lập từng suite, song song, không mock Prisma/BullMQ;
harness trong `libs/core/server/testing`) / API e2e (endpoints, error paths, upload, rate
limit, idempotency, CSRF, api-key) / Web e2e (Playwright: auth, org, CRUD,
realtime, vi/en) / Contract (drift) / Isolation (negative 2 lớp + **query
tenant-scoped trần không context phải bị extension THROW — không được trả
rỗng âm thầm**) / Jobs
(kill/retry/dedup/drain/outbox-crash) / **Quota concurrency** (STRICT: DB
reservation không double-spend, FAST: Redis Lua
dưới tải song song). **Taxonomy — không phải test nào cũng Testcontainers:**
logic thuần (authz rules, quota algorithm, cursor encode/decode,
ProblemDetails mapping, idempotency fingerprint) = unit test cực nhanh;
Testcontainers CHỈ cho thứ cần infra thật (RLS, transaction, outbox, BullMQ,
Redis concurrency). Gate mỗi phase: run-many + smoke tay; CI nx affected.

**Failure matrix (multi-instance là ràng buộc 5 — phải TIÊM lỗi, không chỉ
hy vọng):** DoD các phase liên quan gồm bảng inject: api chết giữa
transaction (→ rollback sạch, không outbox mồ côi); worker chết sau claim
(→ lease reclaim); redis-cache mất (→ app sống, chỉ chậm); redis-critical
restart (→ BullMQ/quota phục hồi từ AOF/DB); DB connection reset (→ retry
+ fail loud); relay chết sau enqueue trước update (→ jobId dedup nuốt
duplicate); Caddy đứt SSE (→ client reconnect Last-Event-ID); duplicate
delivery (→ inbox dedup). Mỗi dòng: expected behavior + test chứng minh.

## 9. Rủi ro & giảm thiểu (mức TB trở lên)

| Rủi ro | Giảm thiểu |
|---|---|
| shadcn chưa first-class Nx | Pattern components.json; fallback Tailwind |
| TS7 dual-install | Bước riêng, benchmark, rollback 2 dòng |
| better-auth cộng đồng nhỏ | Boundary feature-auth; audit tự có |
| RLS vận hành | Pattern production; helpers; EXPLAIN; negative tests |
| Impersonation quyền lực lớn | Thời hạn + audit + banner; chỉ system role |
| Webhook SSRF/lộ secret | Validate URL đích; HMAC; HTTPS-only |
| Queue/authz/flags facade leak | Common denominator; ESLint boundary; review |
| Socket.IO multi-instance | websocket-only; e2e 2-instance |
| Fastify: một số Express middleware không tương thích | Ưu tiên plugin `@fastify/*` chính chủ; `@fastify/middie` là fallback; better-auth qua lib hỗ trợ Fastify (candidates: underfisk/nestjs-better-auth, nestjs-better-auth-fastify) — chốt lib cụ thể ở plan Phase 3 |
| Quota sai lệch giữa Redis và DB | STRICT: DB là enforcement — không có drift enforcement; FAST: chấp nhận sai số, đối soát bằng usage events (6.7) |
| Redis eviction/restart giết cơ chế critical | Tách redis-critical (noeviction, AOF) vs redis-cache (allkeys-lru); idempotency durable ở DB |
| AI cost không kiểm soát | Token usage → quota engine; không hardcode vendor |
| RLS read path: SELECT trần trả rỗng âm thầm | Extension wrap MỌI op kể cả read; thiếu context → THROW; negative test bắt buộc (mục 8) |
| **Boilerplate thành dự án vĩnh viễn "sắp xong"** | Usable milestone sau Phase 3 — sản phẩm thật build song song Phase 4–6; tiêu chí dừng: hết Phase 6 + một sản phẩm thật đang dùng nền |

## 10. upgrades.md — các mục bắt buộc (ràng buộc 7)

Mỗi mục: *tín hiệu khi nào nâng + bước nâng*. Danh sách khởi điểm: SSO
enterprise (SAML/OIDC per-org); billing gateway (Stripe/Polar ←
onPlanChanged + usage events); ReBAC OpenFGA/SpiceDB (← authz facade);
Kafka (← đổi relay outbox); search ladder Meili/Typesense → Elastic;
flags provider Unleash/Flagsmith (← OpenFeature); tách platform/auth;
platform/gateway; GraphQL; NestJS 12; Rspack; Biome; TS 7.1 gỡ
dual-install; Nx Cloud; Prisma 8; pg-boss/RabbitMQ; gRPC; Sentry; k6; AV
scan; preview environments; scheduler entry riêng; HA multi-node (rời 1
VPS); backup nâng cao (PITR/WAL-G); state manager FE (khi local state phức
tạp thật); per-aggregate event ordering (partition theo aggregate id — khi
có consumer phụ thuộc thứ tự thật).

## 11. MCP servers

nx-mcp, context7, prisma-local: đã cài. shadcn MCP + Next DevTools MCP:
Phase 1.

## 12. Nguồn đã verify (09/2026)

**Yêu cầu audit-able (Phase 1 giao):** chuyển danh sách dưới thành
`docs/sources.md` dạng bảng `Claim | Source URL | Ngày truy cập | Version |
ADR liên quan` — bắt buộc cho các điểm nhạy cảm: Nx 23, Next 16, Prisma 7,
PG18, TS7, AI SDK v7, better-auth, Kafka 4.2.

Nx (changelog 23/23.1, kb/typescript-7, ci-workflow, @nx/docker, nx release);
NestJS (SWC, v12, websockets, @Sse); BullMQ (Job Schedulers, dedup, #2876);
Next 16; Prisma (7 recommended, uuid(7), client-extensions RLS); PG18
uuidv7(); hey-api; shadcn+Nx; next-intl; pnpm catalogs; better-auth
(organizations/AC/dynamic roles, SSO 1.5, **multi-session, api-key package**);
nestjs-pino; Zalando (cursor opaque); S3 presign 3 dạng; SSE vs WS; BullMQ
vs pg-boss vs RabbitMQ; RLS production pattern; Kafka 4.2 KIP-932 GA
(+4.2.1 fix); outbox (AWS, event-driven.io); search PG FTS/Meili/Typesense/
Elastic (license ELv2); **Vercel AI SDK v7 + pgvector + Prisma Unsupported**;
OpenFeature; Biome/ESLint; Vitest/Jest; bundlers 2026. **Repo tham khảo đã
review:** chuanghiduoc/nestjs-fastify-nx (security pipeline 5 lớp, container
hardening, Testcontainers, Bull Board, Lefthook, migration entry, API-key
scope rule), chuanghiduoc/viai-monorepo (knip, backend URL server-only,
Docker context tối thiểu, 3 FE landing/app/admin).
