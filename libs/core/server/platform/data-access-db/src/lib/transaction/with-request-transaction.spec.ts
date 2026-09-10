import {
  SYSTEM_CONTEXT,
  withRequestContext,
  type RequestContext,
} from '@workspace/core-server-core';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from './database.js';

const ORG_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const USER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const requestContext: RequestContext = {
  principal: { type: 'user', id: USER_ID, orgId: ORG_ID, roles: ['member'] },
  tenant: { kind: 'org', orgId: ORG_ID, userId: USER_ID },
};

describe('withRequestTransaction', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  const readOrgGuc = () =>
    db
      .tenant()
      .$queryRawUnsafe<{ org: string | null }[]>(
        `SELECT NULLIF(current_setting('app.current_org_id', true), '') AS org`,
      );

  it('opens a transaction for the tenant the request resolved to', async () => {
    const rows = await withRequestContext(requestContext, () =>
      db.withRequestTransaction(readOrgGuc),
    );

    expect(rows).toEqual([{ org: ORG_ID }]);
  });

  it('says what is missing when there is no request context', async () => {
    // A service reached from a job or a script has no request. Guessing a
    // tenant would be the worst possible recovery.
    await expect(
      db.withRequestTransaction(async () => undefined),
    ).rejects.toThrow(/no request context/i);
  });

  it('joins a transaction already open for the same tenant', async () => {
    const joined = await withRequestContext(requestContext, () =>
      db.withTenantTransaction(requestContext.tenant as never, async () => {
        const outer = db.tenant();
        await db.withRequestTransaction(async () => {
          expect(db.tenant()).toBe(outer);
        });
        return true;
      }),
    );

    expect(joined).toBe(true);
  });

  it('refuses to run inside a transaction opened for someone else', async () => {
    const other: RequestContext = {
      ...requestContext,
      tenant: { kind: 'org', orgId: USER_ID, userId: USER_ID },
    };

    await expect(
      withRequestContext(other, () =>
        db.withTenantTransaction(requestContext.tenant as never, () =>
          db.withRequestTransaction(async () => undefined),
        ),
      ),
    ).rejects.toThrow(/different tenant context/);
  });

  it('is not fooled by a system transaction', async () => {
    await expect(
      withRequestContext(requestContext, () =>
        db.withSystemTransaction(() =>
          db.withRequestTransaction(async () => undefined),
        ),
      ),
    ).rejects.toThrow(/different tenant context/);
  });

  it('leaves the system path alone', async () => {
    const rows = await db.withSystemTransaction(() =>
      db
        .system()
        .$queryRawUnsafe<{ org: string | null }[]>(
          `SELECT NULLIF(current_setting('app.current_org_id', true), '') AS org`,
        ),
    );

    expect(rows).toEqual([{ org: null }]);
    expect(SYSTEM_CONTEXT.kind).toBe('system');
  });
});
