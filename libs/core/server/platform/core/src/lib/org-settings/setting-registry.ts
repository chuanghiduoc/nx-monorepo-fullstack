import { z } from 'zod';

/**
 * Every setting an organization can hold, and the shape its value must take.
 *
 * A setting is added by registering a schema here, not by migrating a table.
 * That is what makes the storage key-value; the schema is what stops key-value
 * from meaning "anything goes". A value that does not parse is rejected at the
 * boundary, so nothing downstream has to wonder whether a setting is sane.
 */
export const SETTING_SCHEMAS = {
  /**
   * Addresses allowed to reach this organization's data, as IPv4 or IPv6
   * addresses or CIDR ranges. An empty list means no restriction — the
   * absence of a rule, not a rule that admits nobody.
   */
  'security.ipAllowlist': z.array(z.string().min(1)).max(200).default([]),

  /** Where invitations and notifications come from. */
  'notifications.replyTo': z.email().optional(),

  /** Days of inactivity after which a member's session is ended. */
  'security.sessionIdleDays': z.number().int().min(1).max(365).default(30),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

export type SettingValue<K extends SettingKey> = z.infer<
  (typeof SETTING_SCHEMAS)[K]
>;

/** Raised when a key nobody registered is read or written. */
export class UnknownSettingError extends Error {
  constructor(key: string) {
    super(
      `"${key}" is not a known setting. Register a schema for it in the setting registry.`,
    );
    this.name = 'UnknownSettingError';
  }
}

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_SCHEMAS;
}

/**
 * Parses a stored or submitted value.
 *
 * Unknown keys are refused rather than passed through: a typo in a key would
 * otherwise be stored happily and read back as "not set", which looks exactly
 * like a setting nobody has configured.
 */
export function parseSetting<K extends SettingKey>(
  key: K,
  value: unknown,
): SettingValue<K> {
  if (!isSettingKey(key)) {
    throw new UnknownSettingError(key);
  }

  return SETTING_SCHEMAS[key].parse(value) as SettingValue<K>;
}

/** The value a setting has when an organization has never set it. */
export function defaultSetting<K extends SettingKey>(key: K): SettingValue<K> {
  if (!isSettingKey(key)) {
    throw new UnknownSettingError(key);
  }

  const parsed = SETTING_SCHEMAS[key].safeParse(undefined);
  return (parsed.success ? parsed.data : undefined) as SettingValue<K>;
}
