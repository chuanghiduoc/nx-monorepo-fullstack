import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import { AppConfig } from '@workspace/core-server-core';
import {
  Database,
  WebhookRepository,
  type WebhookEndpointView,
} from '@workspace/core-server-data-access-db';
import {
  generateSecret,
  pinDestination,
  UnsafeDestinationError,
} from '@workspace/core-server-webhooks';

export interface CreatedEndpoint extends WebhookEndpointView {
  /** Returned once. No route can produce it again — the grant forbids it. */
  readonly secret: string;
}

/**
 * Managing where an organization's events are sent.
 *
 * Creating and changing an endpoint is an administrative act: it carries a
 * secret and it receives every event the organization raises. Members may
 * read, because seeing where events go is what somebody needs when a delivery
 * fails, and no role can read a secret at all.
 */
@Injectable()
export class WebhooksService {
  private readonly db: Database;
  private readonly webhooks: WebhookRepository;
  private readonly authz: AuthzService;
  private readonly config: AppConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(WebhookRepository) webhooks: WebhookRepository,
    @Inject(AuthzService) authz: AuthzService,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.db = db;
    this.webhooks = webhooks;
    this.authz = authz;
    this.config = config;
  }

  async create(
    principal: Principal,
    orgId: string,
    input: { url: string; eventTypes: string[] },
  ): Promise<CreatedEndpoint> {
    this.authz.require(principal, 'webhook.create', { orgId });

    // Validated here as well as before every delivery. Refusing at creation is
    // what turns "this endpoint never fires" into a message at the moment
    // somebody can still fix the URL.
    await this.assertReachable(input.url);

    const secret = generateSecret();

    const id = await this.db.withRequestTransaction(() =>
      this.webhooks.create(orgId, { ...input, secret }),
    );

    const created = (await this.list(principal, orgId)).find(
      (endpoint) => endpoint.id === id,
    );

    if (created === undefined) {
      throw new Error(`The webhook endpoint ${id} vanished as it was created.`);
    }

    return { ...created, secret };
  }

  async list(
    principal: Principal,
    orgId: string,
  ): Promise<WebhookEndpointView[]> {
    this.authz.require(principal, 'webhook.read', { orgId });

    return this.db.withRequestTransaction(() => this.webhooks.list(orgId));
  }

  async update(
    principal: Principal,
    orgId: string,
    id: string,
    changes: { url?: string; eventTypes?: string[]; enabled?: boolean },
  ): Promise<void> {
    this.authz.require(principal, 'webhook.update', { orgId, resourceId: id });

    if (changes.url !== undefined) {
      await this.assertReachable(changes.url);
    }

    const changed = await this.db.withRequestTransaction(() =>
      this.webhooks.update(orgId, id, changes),
    );

    if (!changed) {
      // The policy already scopes the update to this organization, so a miss
      // means it is not there — for this caller, which is the only sense of
      // "there" that matters.
      throw new NotFoundException('No such webhook endpoint');
    }
  }

  async remove(
    principal: Principal,
    orgId: string,
    id: string,
  ): Promise<void> {
    this.authz.require(principal, 'webhook.delete', { orgId, resourceId: id });

    const removed = await this.db.withRequestTransaction(() =>
      this.webhooks.remove(orgId, id),
    );

    if (!removed) {
      throw new NotFoundException('No such webhook endpoint');
    }
  }

  /**
   * Refuses a URL this service must not call.
   *
   * The same check the sender makes, run early so the failure arrives as a 400
   * on the request that set it rather than as a dead letter a week later. It
   * is not a substitute for the one at delivery time: the address a name
   * resolves to can change, which is the whole reason that one exists.
   */
  private async assertReachable(url: string): Promise<void> {
    try {
      await pinDestination(url, {
        requireHttps: this.config.get('NODE_ENV') === 'production',
      });
    } catch (failure) {
      if (failure instanceof UnsafeDestinationError) {
        throw new BadRequestException(failure.message);
      }
      throw failure;
    }
  }
}
