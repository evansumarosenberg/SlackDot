import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(),
  args: text('args').notNull(), conversation: text('conversation').notNull(), thread: text('thread'),
  callback: text('callback').notNull(), secret: text('secret'), secretHash: text('secret_hash').notNull(),
  previousSecret: text('previous_secret'), previousSecretExpiresAt: integer('previous_secret_expires_at'),
  verifiedAt: integer('verified_at').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), active: integer('active').notNull(),
});

// No Slack identifiers or payloads: the key is a domain-separated keyed hash.
export const eventDedup = sqliteTable('event_dedup', {
  key: text('key').primaryKey(),
  state: text('state', {enum:['processing','delivered','failed']}).notNull(),
  claimToken: text('claim_token'),
  claimExpiresAt: integer('claim_expires_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table=>[index('event_dedup_expiry').on(table.expiresAt)]);
