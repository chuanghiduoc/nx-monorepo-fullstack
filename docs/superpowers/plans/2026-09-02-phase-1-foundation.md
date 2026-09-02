# Phase 1 — Nền tảng: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng workspace Nx hoàn chỉnh: core-api (NestJS+Fastify) + core-web (Next.js) + shell libs + boundaries + tooling (catalogs, Lefthook, release, Renovate, knip, CI + security, compose dev, shadcn, local generators, TS7) — dev mới clone về chạy được toàn stack bằng một lệnh.

**Architecture:** Scope-based naming (`apps/core/*`, `libs/shared/*`, `libs/core/*`), boundaries enforce bằng tags + ESLint. Mọi thứ sinh bằng generator chính chủ; chỉ cấu hình những gì generator không làm.

**Tech Stack:** Nx 23, pnpm, NestJS 11 + Fastify, Next.js 16, Vitest, Tailwind + shadcn, TS7 dual-install.

**Spec:** `docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md` (mục 4, 7-Phase 1)

## Global Constraints

- **CẤM viết version thủ công** vào package.json — chỉ `pnpm add`/`nx add`/generator. Ngoại lệ duy nhất trong plan này: TS7 dual-install aliases (Task 16 — copy nguyên văn từ Nx docs `kb/typescript-7`).
- Package manager: **pnpm**. Mọi lệnh nx chạy qua `pnpm nx ...`.
- Thư mục làm việc sau Task 1: `D:/nx-monorepo-fullstack/nx-monorepo-fullstack` (mọi task từ 2 trở đi chạy trong đây).
- Commit theo conventional commits sau MỖI task (commit-msg hook sẽ enforce từ Task 8).
- Nếu một lệnh generator báo flag không tồn tại: chạy `pnpm nx g <generator> --help` xem flag thật rồi điều chỉnh — KHÔNG bỏ qua bước, KHÔNG tự chế file mà generator có thể sinh.
- Môi trường: Windows + Git Bash. Path dùng forward slash.
- MCP `nx_docs` đang có sẵn — dùng nó khi cần tra cấu hình Nx thay vì đoán.

---

### Task 1: Tạo workspace + đưa spec vào repo

**Files:**
- Create: workspace `nx-monorepo-fullstack/` (generator sinh)
- Create: `docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md` (copy từ ngoài)
- Create: `docs/superpowers/plans/2026-09-02-phase-1-foundation.md` (copy chính file này)

**Interfaces:**
- Produces: workspace root với `nx.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, git repo đã init — mọi task sau chạy trong đây.

- [ ] **Step 1: Tạo workspace**

```bash
cd /d/nx-monorepo-fullstack
npx create-nx-workspace@latest nx-monorepo-fullstack --preset=ts --pm=pnpm --nxCloud=skip --no-interactive
```

- [ ] **Step 2: Verify workspace**

```bash
cd /d/nx-monorepo-fullstack/nx-monorepo-fullstack
cat nx.json | head -20 && cat pnpm-workspace.yaml && git log --oneline
```
Expected: nx.json tồn tại, pnpm-workspace.yaml có `packages:`, có initial commit.

- [ ] **Step 3: Copy spec + plan vào workspace**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans docs/adr
cp ../docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md docs/superpowers/specs/
cp ../docs/superpowers/plans/2026-09-02-phase-1-foundation.md docs/superpowers/plans/
```

- [ ] **Step 4: Commit**

```bash
git add docs && git commit -m "docs: add architecture spec and phase 1 plan"
```

---

### Task 2: NestJS app `core-api` + Fastify adapter

**Files:**
- Create: `apps/core/api/**` + `apps/core/api-e2e/**` (generator sinh)
- Modify: `apps/core/api/src/main.ts` (Fastify adapter)

**Interfaces:**
- Produces: project `core-api` (serve tại http://localhost:3000/api), dùng `NestFastifyApplication`.

- [ ] **Step 1: Cài plugin + generate app**

```bash
pnpm nx add @nx/nest
pnpm nx g @nx/nest:application apps/core/api
```
Nếu generator hỏi/không nhận path positional: `pnpm nx g @nx/nest:application --help` rồi dùng flag `--directory=apps/core/api` tương ứng.

- [ ] **Step 2: Verify app chạy với Express mặc định**

```bash
pnpm nx serve core-api &
sleep 15 && curl -s http://localhost:3000/api && kill %1
```
Expected: JSON `{"message":"Hello API"}`.

- [ ] **Step 3: Cài Fastify adapter (installer resolve version)**

```bash
pnpm add @nestjs/platform-fastify
```

- [ ] **Step 4: Chuyển main.ts sang Fastify**

Thay nội dung `apps/core/api/src/main.ts` (giữ nguyên import AppModule/Logger có sẵn của generator, chỉ đổi phần tạo app):

```typescript
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter()
  );
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
  Logger.log(`🚀 core-api running on http://localhost:${port}/${globalPrefix}`);
}

bootstrap();
```

- [ ] **Step 5: Verify Fastify chạy + e2e của generator vẫn xanh**

```bash
pnpm nx serve core-api &
sleep 15 && curl -s http://localhost:3000/api && kill %1
pnpm nx e2e core-api-e2e
```
Expected: cùng JSON; e2e PASS. Nếu e2e fail vì adapter: đọc lỗi, sửa test setup của api-e2e cho Fastify (thường không cần — e2e gọi HTTP thật).

- [ ] **Step 6: Commit**

```bash
git add . && git commit -m "feat(core-api): scaffold nestjs app with fastify adapter"
```

---

### Task 3: Next.js app `core-web`

**Files:**
- Create: `apps/core/web/**` + `apps/core/web-e2e/**` (generator sinh, Playwright)

**Interfaces:**
- Produces: project `core-web` (App Router, Tailwind) serve tại http://localhost:4200.

- [ ] **Step 1: Cài plugin + generate app**

```bash
pnpm nx add @nx/next
pnpm nx g @nx/next:application apps/core/web --style=tailwind
```

- [ ] **Step 2: Verify serve**

```bash
pnpm nx serve core-web &
sleep 30 && curl -s -o /dev/null -w "%{http_code}" http://localhost:4200 && kill %1
```
Expected: `200`.

- [ ] **Step 3: Verify build production**

```bash
pnpm nx build core-web
```
Expected: build xanh (Turbopack/Next 16).

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(core-web): scaffold nextjs app with tailwind"
```

---

### Task 4: Vitest là test runner mặc định

**Files:**
- Modify: `nx.json` (generator defaults)

**Interfaces:**
- Produces: mọi lib generate sau này mặc định `unitTestRunner: vitest`; target `test` chạy Vitest.

- [ ] **Step 1: Cài plugin**

```bash
pnpm nx add @nx/vitest
```

- [ ] **Step 2: Set generator defaults trong nx.json**

Thêm vào `nx.json` (merge vào key `generators` nếu đã có):

```json
{
  "generators": {
    "@nx/js:library": { "unitTestRunner": "vitest" },
    "@nx/react:library": { "unitTestRunner": "vitest" }
  }
}
```

- [ ] **Step 3: Verify bằng lib tạm**

```bash
pnpm nx g @nx/js:library libs/tmp-probe
ls libs/tmp-probe/vite.config.ts || ls libs/tmp-probe/vitest.config.ts
pnpm nx test tmp-probe
pnpm nx g @nx/workspace:remove tmp-probe --forceRemove
```
Expected: config vitest tồn tại, test PASS, lib xóa sạch.

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "chore: set vitest as default unit test runner"
```

---

### Task 5: Shell libs — `shared/ui`, `shared/api-client-core`, `shared/i18n`

**Files:**
- Create: `libs/shared/ui/**` (React lib), `libs/shared/api-client-core/**`, `libs/shared/i18n/**` (JS libs)

**Interfaces:**
- Produces: import paths `@nx-monorepo-fullstack/shared-ui`, `.../shared-api-client-core`, `.../shared-i18n` (xem tên thật trong tsconfig.base.json sau generate — dùng đúng tên đó ở Task 12).

- [ ] **Step 1: Generate 3 libs**

```bash
pnpm nx g @nx/react:library libs/shared/ui --bundler=none --style=css
pnpm nx g @nx/js:library libs/shared/api-client-core
pnpm nx g @nx/js:library libs/shared/i18n
```
(`@nx/react` đã có sẵn — là dependency của `@nx/next`; nếu thiếu: `pnpm nx add @nx/react`.)

- [ ] **Step 2: Đánh dấu api-client-core là code sinh tự động**

Ghi đè `libs/shared/api-client-core/README.md`:

```markdown
# shared-api-client-core

⚠️ TOÀN BỘ code trong `src/` của lib này sẽ do hey-api SINH TỰ ĐỘNG từ
`openapi.json` (Phase 2). CẤM sửa tay. Chỉ config codegen được phép sửa.
```

- [ ] **Step 3: Verify graph + test**

```bash
pnpm nx run-many -t test --projects=shared-ui,shared-api-client-core,shared-i18n
pnpm nx graph --file=graph.json && node -e "const g=require('./graph.json');console.log(Object.keys(g.graph.nodes))" && rm graph.json
```
Expected: 3 test PASS; graph liệt kê đủ project (ghi lại TÊN PROJECT THẬT — dùng cho Task 6).

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "feat(shared): scaffold ui, api-client-core, i18n shell libs"
```

---

### Task 6: Tags + enforce-module-boundaries

**Files:**
- Modify: `package.json`/`project.json` của từng project (thêm `nx.tags` hoặc `tags`)
- Modify: ESLint config gốc (file `eslint.config.mjs` hoặc `.eslintrc.json` — xem file thật generator đã tạo)

**Interfaces:**
- Produces: ma trận boundary bị lint ép. Tags chuẩn: `scope:core|shared`, `platform:node|web|shared` (`platform:shared` = lib thuần không phụ thuộc runtime nào, cả node lẫn web import được), `type:app|feature|data-access|ui|util`.

- [ ] **Step 1: Gán tags**

| Project | Tags |
|---|---|
| core-api, core-api-e2e | `scope:core`, `platform:node`, `type:app` |
| core-web, core-web-e2e | `scope:core`, `platform:web`, `type:app` |
| shared-ui | `scope:shared`, `platform:web`, `type:ui` |
| shared-api-client-core | `scope:shared`, `platform:web`, `type:data-access` |
| shared-i18n | `scope:shared`, `platform:shared`, `type:util` |

Với mỗi project: mở `project.json` (hoặc key `nx` trong `package.json` của lib) thêm `"tags": [...]` như bảng.

- [ ] **Step 2: Viết depConstraints vào ESLint config gốc**

Tìm block `@nx/enforce-module-boundaries` có sẵn trong ESLint config gốc, thay `depConstraints` bằng:

```javascript
depConstraints: [
  { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
  { sourceTag: 'scope:core', onlyDependOnLibsWithTags: ['scope:core', 'scope:shared'] },
  { sourceTag: 'platform:node', onlyDependOnLibsWithTags: ['platform:node', 'platform:shared'] },
  { sourceTag: 'platform:web', onlyDependOnLibsWithTags: ['platform:web', 'platform:shared'] },
  { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
  { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:util'] },
  { sourceTag: 'type:data-access', onlyDependOnLibsWithTags: ['type:data-access', 'type:util'] },
  // feature KHÔNG import feature (spec v10 §4 luật 3) — cross-feature qua domain events/contracts
  { sourceTag: 'type:feature', onlyDependOnLibsWithTags: ['type:ui', 'type:data-access', 'type:util'] },
  { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:data-access', 'type:util'] },
]
```

- [ ] **Step 3: Viết test âm — vi phạm phải bị bắt**

Thêm tạm vào `libs/shared/i18n/src/index.ts` một dòng import từ core-api (ví dụ `import '../../../../apps/core/api/src/main';`), chạy:

```bash
pnpm nx lint shared-i18n
```
Expected: **FAIL** với lỗi enforce-module-boundaries. Gỡ dòng import đi, lint lại → PASS. (Nếu không fail: depConstraints chưa ăn — kiểm tra tags + vị trí block trong config, sửa tới khi fail đúng.)

- [ ] **Step 4: Lint toàn bộ + commit**

```bash
pnpm nx run-many -t lint
git add . && git commit -m "chore: add project tags and enforce module boundaries"
```

---

### Task 7: pnpm catalogs

**Files:**
- Modify: `pnpm-workspace.yaml`, `package.json` (root)

**Interfaces:**
- Produces: quy ước — dependency runtime dùng chung khai báo trong `catalog:`; các package.json tham chiếu `"catalog:"`.

- [ ] **Step 1: Chuyển dependency runtime hiện có vào catalog**

Xem `dependencies` trong `package.json` root (sau Task 2-3 sẽ có ít nhất: @nestjs/*, @nestjs/platform-fastify, next, react, react-dom, tailwindcss...). Với TỪNG dependency runtime: copy `"tên": "version-hiện-tại"` (version do installer đã resolve — không tự bịa) vào `pnpm-workspace.yaml`:

```yaml
catalog:
  '@nestjs/common': <giữ nguyên range installer đã ghi>
  '@nestjs/core': <giữ nguyên>
  '@nestjs/platform-fastify': <giữ nguyên>
  # ... từng runtime dep một
```

rồi đổi giá trị trong `package.json` thành `"catalog:"`. KHÔNG đưa devDependencies tooling của Nx (@nx/*) vào catalog — `nx migrate` quản chúng.

- [ ] **Step 2: Verify**

```bash
pnpm install
pnpm nx run-many -t build --projects=core-api,core-web
grep -c "catalog:" package.json
```
Expected: install sạch, build xanh, có ≥5 tham chiếu catalog.

- [ ] **Step 3: Commit**

```bash
git add . && git commit -m "chore: manage shared runtime deps via pnpm catalog"
```

---

### Task 8: Lefthook + commitlint (+ gitleaks guard)

**Files:**
- Create: `lefthook.yml`, `commitlint.config.mjs`

- [ ] **Step 1: Cài**

```bash
pnpm add -D lefthook @commitlint/cli @commitlint/config-conventional
pnpm lefthook install
```

- [ ] **Step 2: Config**

`commitlint.config.mjs`:
```javascript
export default { extends: ['@commitlint/config-conventional'] };
```

`lefthook.yml`:
```yaml
commit-msg:
  commands:
    commitlint:
      run: pnpm commitlint --edit {1}
pre-commit:
  commands:
    lint-affected:
      run: pnpm nx affected -t lint --base=HEAD
pre-push:
  commands:
    typecheck-affected:
      run: pnpm nx affected -t typecheck build --base=origin/main --head=HEAD
    gitleaks:
      run: sh -c 'command -v gitleaks >/dev/null && gitleaks git --pre-push --staged || echo "gitleaks not installed locally - CI will scan"'
```

- [ ] **Step 3: Test âm — commit message sai phải bị chặn**

```bash
git add lefthook.yml commitlint.config.mjs
git commit -m "bad message" ; echo "exit=$?"
```
Expected: exit ≠ 0 (commitlint chặn).

- [ ] **Step 4: Commit đúng chuẩn**

```bash
git commit -m "chore: add lefthook with commitlint and gitleaks guard"
```

---

### Task 9: nx release + Renovate + knip

**Files:**
- Modify: `nx.json` (release)
- Create: `renovate.json`, `knip.json`

- [ ] **Step 1: nx release config** — thêm vào `nx.json`:

```json
{
  "release": {
    "projectsRelationship": "fixed",
    "version": { "conventionalCommits": true },
    "changelog": { "workspaceChangelog": { "createRelease": "github" } }
  }
}
```

Verify: `pnpm nx release version --dry-run` → chạy được, báo version dự kiến (hoặc "no changes" hợp lệ).

- [ ] **Step 2: Renovate** — tạo `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":semanticCommits"],
  "postUpdateOptions": ["pnpmDedupe"],
  "packageRules": [
    { "matchPackagePatterns": ["^@nx/", "^nx$"], "enabled": false, "description": "Nx packages upgrade via nx migrate, not Renovate" }
  ]
}
```

- [ ] **Step 3: knip**

```bash
pnpm add -D knip
```
Tạo `knip.json`:
```json
{ "$schema": "https://unpkg.com/knip@latest/schema.json", "ignoreDependencies": ["tslib"] }
```
Thêm script vào package.json root: `"knip": "knip"`. Chạy `pnpm knip` — đọc output: sửa các finding thật (dep thừa), thêm vào ignore những false positive có lý do (ghi comment lý do trong knip.json không được — ghi vào ADR-0001 ở Task 15).

- [ ] **Step 4: Commit**

```bash
git add . && git commit -m "chore: configure nx release, renovate and knip"
```

---

### Task 10: docker-compose dev

**Files:**
- Create: `docker-compose.yml`, `.env.example`

**Interfaces:**
- Produces: Postgres 18 (5432), Redis (6379), Mailpit (1025/8025), MinIO (9000/9001), otel-lgtm (profile `observability`: 3001 Grafana, 4317/4318 OTLP).

- [ ] **Step 1: Viết compose**

`docker-compose.yml`:
```yaml
name: nx-monorepo-fullstack
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      retries: 10
  redis-critical:
    image: redis:8-alpine
    command: redis-server --maxmemory-policy noeviction --appendonly yes
    ports: ['6379:6379']
    volumes: ['redisdata:/data']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      retries: 10
  redis-cache:
    image: redis:8-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    ports: ['6380:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      retries: 10
  mailpit:
    image: axllent/mailpit:latest
    ports: ['1025:1025', '8025:8025']
  minio:
    image: minio/minio:latest
    command: server /data --console-address ':9001'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio12345
    ports: ['9000:9000', '9001:9001']
    volumes: ['miniodata:/data']
  otel-lgtm:
    image: grafana/otel-lgtm:latest
    profiles: ['observability']
    ports: ['3001:3000', '4317:4317', '4318:4318']
volumes:
  pgdata:
  redisdata:
  miniodata:
```

`.env.example`:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
REDIS_CRITICAL_URL=redis://localhost:6379
REDIS_CACHE_URL=redis://localhost:6380
SMTP_HOST=localhost
SMTP_PORT=1025
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio12345
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

- [ ] **Step 2: Verify**

```bash
docker compose up -d
docker compose ps --format '{{.Name}} {{.Status}}'
docker compose --profile observability up -d otel-lgtm && sleep 20
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 && curl -s -o /dev/null -w " %{http_code}" http://localhost:8025 && echo
docker compose --profile observability down
docker compose up -d
```
Expected: 5 service lõi healthy/up (postgres, redis-critical, redis-cache, mailpit, minio); Grafana 200 (3001); Mailpit 200 (8025).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml .env.example && git commit -m "chore: add dev docker compose (pg18, redis, mailpit, minio, otel-lgtm)"
```

---

### Task 11: One-command onboarding

**Files:**
- Modify: `package.json` (scripts)
- Create: `README.md` (ghi đè bản generator)

- [ ] **Step 1: Scripts** — thêm vào `package.json` root:

```json
{
  "scripts": {
    "dev": "docker compose up -d && nx run-many -t serve --projects=core-api,core-web",
    "dev:down": "docker compose down",
    "verify": "nx run-many -t lint typecheck test build"
  }
}
```

Ghi chú chủ đích: spec yêu cầu onboarding gồm cả migrate + seed — hai bước đó
thuộc Phase 2 (Prisma chưa tồn tại ở Phase 1). Plan Phase 2 PHẢI nối
`prisma migrate deploy` + seed vào script `dev` này — đây là khoản nợ có địa
chỉ, không phải bỏ sót.

- [ ] **Step 2: README.md** — ghi đè:

```markdown
# nx-monorepo-fullstack

Nền tảng full-stack đa mảng: NestJS (Fastify) + Next.js trên Nx. Spec đầy đủ:
`docs/superpowers/specs/`. Hướng nâng cấp: `docs/upgrades.md`.

## Bắt đầu (một lệnh)

pnpm install && pnpm dev

- API: http://localhost:3000/api — Web: http://localhost:4200
- Mailpit UI: http://localhost:8025 — MinIO console: http://localhost:9001
- Observability (tùy chọn): `docker compose --profile observability up -d`
  → Grafana http://localhost:3001

## Lệnh chính

- `pnpm verify` — lint + typecheck + test + build toàn bộ
- `pnpm nx affected -t test` — chỉ test phần bị ảnh hưởng
- `pnpm dev:down` — dừng hạ tầng dev
```

- [ ] **Step 3: Verify từ trạng thái nguội**

```bash
pnpm dev:down && pnpm dev &
sleep 45
curl -s http://localhost:3000/api && curl -s -o /dev/null -w " web=%{http_code}\n" http://localhost:4200
kill %1
```
Expected: API JSON + web=200.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md && git commit -m "docs: one-command onboarding (pnpm dev)"
```

---

### Task 12: shadcn init cho `shared/ui` + MCP servers

**Files:**
- Create: `components.json` (root), `libs/shared/ui/src/components/**`, `libs/shared/ui/src/lib/utils.ts`
- Modify: `apps/core/web/**` (dùng thử Button), `.mcp.json`

**Interfaces:**
- Produces: `npx shadcn add <component>` đổ component vào `libs/shared/ui/src/components`; web import qua alias của shared-ui (tên import path thật lấy từ `tsconfig.base.json` — Task 5 đã ghi nhận).

- [ ] **Step 1: Thử CLI chuẩn trước**

```bash
pnpm dlx shadcn@latest init
```
Nếu CLI init được (chọn đích là lib ui): dùng kết quả của nó. Nếu CLI từ chối vì cấu trúc Nx (đã biết trước — spec mục 9): sang Step 2 config tay theo pattern đã kiểm chứng.

- [ ] **Step 2 (fallback): `components.json` tại root**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "apps/core/web/tailwind.config.js",
    "css": "apps/core/web/src/app/global.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "<import-path-của-shared-ui>/components",
    "utils": "<import-path-của-shared-ui>/lib/utils",
    "ui": "<import-path-của-shared-ui>/components"
  }
}
```
Thay `<import-path-của-shared-ui>` bằng path thật trong `tsconfig.base.json` (vd `@nx-monorepo-fullstack/shared-ui`). Cài util deps bằng installer: `pnpm add clsx tailwind-merge class-variance-authority lucide-react tw-animate-css`. Tạo `libs/shared/ui/src/lib/utils.ts`:

```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Test bằng component thật**

```bash
pnpm dlx shadcn@latest add button
```
Expected: file button đổ vào `libs/shared/ui/src/components/`. Export nó từ `libs/shared/ui/src/index.ts`, import vào `apps/core/web/src/app/page.tsx`, render `<Button>OK</Button>`.

```bash
pnpm nx build core-web && pnpm nx lint shared-ui core-web
```
Expected: xanh (lint xanh chứng minh boundary ui↔web đúng chiều).

- [ ] **Step 4: MCP servers cho workspace**

```bash
claude mcp add shadcn -- npx shadcn@latest mcp
```
Next DevTools MCP: mở https://nextjs.org/docs (mục MCP/DevTools) xác nhận lệnh chính thức hiện tại rồi chạy đúng lệnh đó; nếu docs chưa có lệnh cho CLI thì ghi vào `docs/upgrades.md` mục "Next DevTools MCP — cài khi có hướng dẫn chính thức" và đi tiếp.

- [ ] **Step 5: Commit**

```bash
git add . && git commit -m "feat(shared-ui): shadcn setup with workspace components.json"
```

---

### Task 13: Nx local plugin + generator `feature-lib` / `product-scope`

**Files:**
- Create: `tools/workspace-plugin/**` (generator sinh) + 2 generators

**Interfaces:**
- Produces: `pnpm nx g @nx-monorepo-fullstack/workspace-plugin:feature-lib --name=<x> --scope=<s> --platform=node|web` tạo lib đúng chuẩn tags; `...:product-scope --name=<p>` in checklist tạo scope mới.

- [ ] **Step 1: Scaffold plugin**

```bash
pnpm nx add @nx/plugin
pnpm nx g @nx/plugin:plugin tools/workspace-plugin
pnpm nx g @nx/plugin:generator tools/workspace-plugin/src/generators/feature-lib
pnpm nx g @nx/plugin:generator tools/workspace-plugin/src/generators/product-scope
```

- [ ] **Step 2: Implement `feature-lib`** — ghi đè `tools/workspace-plugin/src/generators/feature-lib/generator.ts`:

```typescript
import { Tree, formatFiles } from '@nx/devkit';
import { libraryGenerator } from '@nx/js';

export interface FeatureLibGeneratorSchema {
  name: string;
  scope: string;
  platform: 'node' | 'web';
}

export async function featureLibGenerator(
  tree: Tree,
  options: FeatureLibGeneratorSchema
) {
  const side = options.platform === 'node' ? 'server' : 'web';
  await libraryGenerator(tree, {
    directory: `libs/${options.scope}/${side}/feature-${options.name}`,
    tags: `scope:${options.scope},platform:${options.platform},type:feature`,
    unitTestRunner: 'vitest',
    linter: 'eslint',
  });
  await formatFiles(tree);
}

export default featureLibGenerator;
```

Cập nhật `schema.json` cùng thư mục cho khớp (3 props: name, scope, platform — required cả 3; platform enum node/web). Cập nhật `schema.d.ts` nếu generator sinh file đó.

- [ ] **Step 3: Implement `product-scope`** — ghi đè generator.ts của nó:

```typescript
import { Tree, formatFiles, generateFiles, joinPathFragments } from '@nx/devkit';

export interface ProductScopeGeneratorSchema { name: string; }

export async function productScopeGenerator(
  tree: Tree,
  options: ProductScopeGeneratorSchema
) {
  const checklist = [
    `# Scope mới: ${options.name}`,
    '',
    'Chạy các lệnh sau (xem spec mục 4):',
    '',
    `- pnpm nx g @nx/nest:application apps/${options.name}/api`,
    `- pnpm nx g @nx/next:application apps/${options.name}/web --style=tailwind`,
    `- Gán tags scope:${options.name} cho các project vừa tạo`,
    `- Thêm dòng depConstraints: scope:${options.name} → [scope:${options.name}, scope:shared]`,
    `- pnpm nx g @nx-monorepo-fullstack/workspace-plugin:feature-lib --scope=${options.name} ...`,
  ].join('\n');
  tree.write(
    joinPathFragments('docs', `scope-${options.name}-checklist.md`),
    checklist
  );
  await formatFiles(tree);
}

export default productScopeGenerator;
```

- [ ] **Step 4: Test bằng cách chạy thật**

```bash
pnpm nx g @nx-monorepo-fullstack/workspace-plugin:feature-lib --name=probe --scope=core --platform=node
cat libs/core/server/feature-probe/project.json | grep -A3 tags
pnpm nx test core-server-feature-probe || pnpm nx test $(pnpm nx show projects | grep feature-probe)
pnpm nx g @nx/workspace:remove $(pnpm nx show projects | grep feature-probe) --forceRemove
```
Expected: lib tạo đúng path + tags đủ 3 loại; test PASS; xóa sạch. (Tên plugin trong lệnh `@nx-monorepo-fullstack/workspace-plugin` — xác nhận tên thật trong `tools/workspace-plugin/package.json`.)

- [ ] **Step 5: Commit**

```bash
git add . && git commit -m "feat(tools): workspace generators feature-lib and product-scope"
```

---

### Task 14: CI workflow + security scan

**Files:**
- Create: `.github/workflows/ci.yml` (generator) — modify: thêm security job

- [ ] **Step 1: Generate**

```bash
pnpm nx g ci-workflow --ci=github
```

- [ ] **Step 2: Thêm security job** — mở `.github/workflows/ci.yml`, thêm job (giữ nguyên job generator sinh):

```yaml
  security:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Gitleaks (secrets)
        uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
      - name: OSV-Scanner (dependencies)
        uses: google/osv-scanner-action/osv-scanner-action@v2
        with: { scan-args: '--lockfile=pnpm-lock.yaml' }
      - name: Semgrep (SAST)
        uses: semgrep/semgrep-action@v1
```
Nếu một action tag không tồn tại khi chạy: mở repo GitHub của action đó xem tag mới nhất, dùng đúng tag — không bỏ bước scan.

- [ ] **Step 3: Thêm knip vào job chính** — trong job main của ci.yml, sau bước affected lint/test/build thêm: `- run: pnpm knip`.

- [ ] **Step 4: Validate cú pháp YAML tại chỗ**

```bash
node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('yaml ok')" 2>/dev/null || pnpm dlx js-yaml .github/workflows/ci.yml > /dev/null && echo "yaml ok"
```
Expected: `yaml ok`. (Chạy thật trên GitHub khi Sếp push — hard stop của CLAUDE.md: không tự push.)

- [ ] **Step 5: Commit**

```bash
git add .github && git commit -m "ci: nx affected workflow with gitleaks, osv-scanner, semgrep"
```

---

### Task 15: ADR-0001 + khung upgrades.md

**Files:**
- Create: `docs/adr/0001-architecture-baseline.md`, `docs/upgrades.md`, `docs/adding-a-service-in-another-language.md`

- [ ] **Step 1: ADR-0001** — nội dung: tóm tắt 10 quyết định lớn từ spec (Nx+pnpm, Fastify, OpenAPI contract, Prisma 7+PG18+UUIDv7, better-auth, BullMQ+outbox, RLS 2 lớp, authz facade, Vitest, TS7 dual-install) — mỗi cái 2 dòng: chọn gì + vì sao, link về spec. Ghi thêm mục "knip ignores" nếu Task 9 có false positive.

- [ ] **Step 2: upgrades.md** — tạo khung từ spec mục 10: mỗi mục là một heading với 2 phần `**Tín hiệu:**` và `**Các bước:**` — điền đủ 25 mục của spec (SSO, billing, ReBAC, Kafka, search ladder, flags provider, platform/auth, gateway, GraphQL, NestJS 12, Rspack, Biome, TS7.1, Nx Cloud, Prisma 8, pg-boss/RabbitMQ, gRPC, Sentry, k6, AV scan, preview env, scheduler entry, HA multi-node, backup PITR, FE state manager). Phase 1 điền chi tiết được ngay các mục: Biome, Rspack, TS 7.1, Nx Cloud, NestJS 12; các mục còn lại ghi tín hiệu + tham chiếu mục spec (chi tiết bổ sung ở phase liên quan).

- [ ] **Step 3: adding-a-service-in-another-language.md** — quy ước service polyglot (từ spec 5.7): nhả openapi.json, ProblemDetails, versioning /v1, cursor pagination, securityScheme; đăng ký `libs/shared/api-client-<service>`; ví dụ lệnh thêm plugin cộng đồng (`@nxlv/python`, `@nx-go/nx-go`).

- [ ] **Step 4: Khung contracts + sources evidence** — tạo `docs/contracts/`
với file rỗng-có-heading cho 7 contract (spec 6.19) ghi "giao ở Phase X";
tạo `docs/sources.md` bảng `Claim | Source URL | Ngày truy cập | Version |
ADR` — điền ngay các dòng Phase 1 chạm tới (Nx 23, TS7 dual-install, PG18)
với URL thật từ spec mục 12.

- [ ] **Step 5: Commit**

```bash
git add docs && git commit -m "docs: ADR-0001, upgrades skeleton, contracts scaffold, sources evidence"
```

---

### Task 16: TS7 dual-install + benchmark (bước riêng, có rollback)

**Files:**
- Modify: `package.json` (2 dòng alias — ngoại lệ vendor-directed từ Nx docs kb/typescript-7)

- [ ] **Step 1: Benchmark TRƯỚC**

```bash
pnpm nx run-many -t typecheck --skip-nx-cache 2>&1 | tail -5
```
Ghi lại thời gian tổng (dòng "Successfully ran..."). Lưu số vào `docs/adr/0001-architecture-baseline.md` mục "TS7 benchmark".

- [ ] **Step 2: Áp alias theo Nx docs** — sửa devDependencies trong `package.json` root (đúng nguyên văn pattern từ nx.dev/docs/kb/typescript-7; xác nhận lại trang đó bằng nx_docs trước khi áp — number minor có thể đã nhích):

```json
{
  "@typescript/native": "npm:typescript@^7.0.2",
  "typescript": "npm:@typescript/typescript6@^6.0.2"
}
```

```bash
pnpm install
```

- [ ] **Step 3: Benchmark SAU + verify toàn bộ**

```bash
pnpm nx reset
pnpm nx run-many -t typecheck --skip-nx-cache 2>&1 | tail -5
pnpm nx run-many -t lint test build
```
Expected: typecheck nhanh hơn rõ rệt; lint/test/build vẫn xanh. Ghi số SAU vào ADR cạnh số TRƯỚC.

- [ ] **Step 4 (nếu vỡ): Rollback** — trả 2 dòng devDependencies về giá trị cũ (git diff cho thấy), `pnpm install`, verify xanh, ghi vào ADR "TS7: thử ngày X, vỡ vì Y, sẽ thử lại khi Z" và vào upgrades.md.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml docs && git commit -m "perf: adopt ts7 native compiler via nx dual-install (benchmarked)"
```

---

### Task 17: Gate cuối Phase 1 (DoD)

- [ ] **Step 1: Verify toàn bộ từ cache lạnh**

```bash
pnpm nx reset && pnpm verify
```
Expected: lint + typecheck + test + build TOÀN BỘ project xanh.

- [ ] **Step 2: Smoke onboarding như dev mới**

```bash
pnpm dev:down && pnpm dev &
sleep 45
curl -s http://localhost:3000/api
curl -s -o /dev/null -w "web=%{http_code}\n" http://localhost:4200
kill %1
```
Expected: API trả JSON, web=200 — đúng DoD "một lệnh chạy toàn stack".

- [ ] **Step 3: Chạy self-review theo CLAUDE.md** — đọc lại `git log --oneline` toàn phase + `git diff` các file config tay (main.ts, eslint boundaries, compose, lefthook, ci.yml, generators): soi lỗi thật, sửa ngay nếu có, verify lại.

- [ ] **Step 4: Commit chốt phase**

```bash
git add -A && git commit -m "chore: phase 1 foundation complete" --allow-empty
```

Báo cáo cho Sếp: các con số benchmark TS7, kết quả gate, những gì lệch so với plan (nếu có) — rồi mới viết plan Phase 2.
