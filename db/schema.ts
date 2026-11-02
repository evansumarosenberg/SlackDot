import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(),
  args: text('args').notNull(), conversation: text('conversation').notNull(), thread: text('thread'),
  callback: text('callback').notNull(), secret: text('secret'), secretHash: text('secret_hash').notNull(),
  verifiedAt: integer('verified_at').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), active: integer('active').notNull(),
});
export const receipts = sqliteTable('receipts', {
  id: text('id').primaryKey(), acceptedAt: integer('accepted_at').notNull(),
});
export const events = sqliteTable('events', {
  id: text('id').primaryKey(), conversation: text('conversation').notNull(),
  thread: text('thread').notNull(), payload: text('payload').notNull(), acceptedAt: integer('accepted_at').notNull(),
});
export const deliveries = sqliteTable('deliveries', {
  eventId: text('event_id').notNull(), subscriptionId: text('subscription_id').notNull(),
  state: text('state').notNull(), attempts: integer('attempts').notNull().default(0),
  nextAt: integer('next_at').notNull(), deadline: integer('deadline').notNull(),
  claim: text('claim'), leaseUntil: integer('lease_until'), lastError: text('last_error'),
}, t => [primaryKey({ columns: [t.eventId, t.subscriptionId] }), index('delivery_due').on(t.state, t.nextAt)]);
export const writes = sqliteTable('writes', {
  id: text('id').primaryKey(), hash: text('hash').notNull(), state: text('state').notNull(),
  result: text('result'), createdAt: integer('created_at').notNull(),
});
export const deliveryNotices = sqliteTable('delivery_notices', {
  eventId:text('event_id').primaryKey(), state:text('state').notNull(),
  lastError:text('last_error'), result:text('result'), createdAt:integer('created_at').notNull(),
});
