import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(),
  args: text('args').notNull(), conversation: text('conversation').notNull(), thread: text('thread'),
  callback: text('callback').notNull(), secret: text('secret'), secretHash: text('secret_hash').notNull(),
  verifiedAt: integer('verified_at').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), active: integer('active').notNull(),
});
