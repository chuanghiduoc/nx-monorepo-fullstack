/**
 * What travels on the bus.
 *
 * `room` rather than a tenant object, because the room is what every consumer
 * needs and deriving it in one place is what keeps an organization's events out
 * of another's stream. Deriving it at each end would be the same rule written
 * twice.
 */
export interface RealtimeMessage {
  readonly room: string;
  /**
   * What happened: `file.ready`, `note.created`.
   *
   * It is also what a client filters on. A separate `topic` field would be the
   * same string twice, and two places for one fact are two places for it to be
   * wrong.
   */
  readonly name: string;
  readonly data: unknown;
  /** When it was published, ISO 8601. */
  readonly at: string;
}

/**
 * Who may see a message.
 *
 * The same split the database makes: someone acting inside an organization
 * shares that organization's stream, and someone acting alone has one of their
 * own.
 *
 * Its own type rather than `TenantScopedContext`, although the split is the
 * same one. That type carries a `userId` beside the organization, which a
 * transaction needs and a room does not — and a publisher that has an
 * organization but no particular person would have to invent one to fill it.
 * A field filled with a lie is worse than a type that does not ask for it.
 *
 * There is no system audience. A relay or a scheduler publishes; it does not
 * subscribe, and a room meaning "everybody" would mean "every organization at
 * once".
 */
export type RealtimeAudience =
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'user'; readonly userId: string };

/**
 * The room a message for that audience belongs in.
 *
 * **Never derived from anything a client sent.** A client that could name its
 * room could name someone else's, and no amount of checking afterwards
 * recovers from that.
 */
export function roomFor(audience: RealtimeAudience): string {
  return audience.kind === 'org'
    ? `org:${audience.orgId}`
    : `user:${audience.userId}`;
}

/**
 * Whether a message is one of the names a subscriber asked for.
 *
 * An empty list means everything: a subscriber that named nothing wants the
 * stream, not silence.
 */
export function matchesNames(
  message: RealtimeMessage,
  names: readonly string[],
): boolean {
  return names.length === 0 || names.includes(message.name);
}
