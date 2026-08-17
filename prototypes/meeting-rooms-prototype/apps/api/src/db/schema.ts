/**
 * WOROOD HUB — Drizzle schema (typed mirror of src/db/migrations/*.sql)
 *
 * The SQL migrations are the source of truth for DDL; this file gives the
 * application end-to-end type safety over the same tables.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/* ========================================================================= */
/* Enums                                                                     */
/* ========================================================================= */

export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'DISABLED']);
export const roomStatusEnum = pgEnum('room_status', ['ACTIVE', 'MAINTENANCE', 'INACTIVE']);
export const reservationStatusEnum = pgEnum('reservation_status', [
  'PENDING',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
]);
export const attendeeResponseEnum = pgEnum('attendee_response', ['INVITED', 'ACCEPTED', 'DECLINED']);

/* ========================================================================= */
/* Core platform                                                             */
/* ========================================================================= */

export const departments = pgTable('core_departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  name: varchar('name', { length: 160 }).notNull(),
  nameAr: varchar('name_ar', { length: 160 }),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'core_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeNo: varchar('employee_no', { length: 32 }).notNull().unique(),
    email: text('email').notNull().unique(), // citext in PostgreSQL
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    fullNameAr: varchar('full_name_ar', { length: 160 }),
    jobTitle: varchar('job_title', { length: 120 }),
    phone: varchar('phone', { length: 32 }),
    avatarUrl: varchar('avatar_url', { length: 255 }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    status: userStatusEnum('status').notNull().default('ACTIVE'),
    locale: varchar('locale', { length: 8 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Africa/Cairo'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    departmentIdx: index('core_users_department_idx').on(t.departmentId),
  }),
);

export const roles = pgTable('core_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  description: varchar('description', { length: 255 }),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable('core_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 96 }).notNull().unique(),
  moduleKey: varchar('module_key', { length: 64 }).notNull(),
  description: varchar('description', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  'core_role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
);

export const userRoles = pgTable(
  'core_user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.roleId] }) }),
);

export const refreshTokens = pgTable(
  'core_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    userAgent: varchar('user_agent', { length: 255 }),
    ipAddress: varchar('ip_address', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('core_refresh_tokens_user_idx').on(t.userId) }),
);

export const auditLogs = pgTable('core_audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  moduleKey: varchar('module_key', { length: 64 }).notNull(),
  action: varchar('action', { length: 96 }).notNull(),
  entityType: varchar('entity_type', { length: 64 }),
  entityId: varchar('entity_id', { length: 64 }),
  metadata: jsonb('metadata'),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('core_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  moduleKey: varchar('module_key', { length: 64 }).notNull(),
  type: varchar('type', { length: 64 }).notNull(),
  title: varchar('title', { length: 190 }).notNull(),
  body: varchar('body', { length: 1000 }),
  link: varchar('link', { length: 255 }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable('core_settings', {
  key: varchar('key', { length: 128 }).primaryKey(),
  moduleKey: varchar('module_key', { length: 64 }).notNull(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ========================================================================= */
/* Module: Meeting Rooms                                                     */
/* ========================================================================= */

export const locations = pgTable('mr_locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  name: varchar('name', { length: 160 }).notNull(),
  nameAr: varchar('name_ar', { length: 160 }),
  building: varchar('building', { length: 120 }),
  address: varchar('address', { length: 255 }),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Africa/Cairo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const equipment = pgTable('mr_equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 48 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  nameAr: varchar('name_ar', { length: 120 }),
  icon: varchar('icon', { length: 48 }),
});

export const rooms = pgTable(
  'mr_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 }).notNull().unique(),
    name: varchar('name', { length: 160 }).notNull(),
    nameAr: varchar('name_ar', { length: 160 }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    floor: varchar('floor', { length: 48 }),
    capacity: integer('capacity').notNull(),
    description: varchar('description', { length: 1000 }),
    photoUrl: varchar('photo_url', { length: 255 }),
    status: roomStatusEnum('status').notNull().default('ACTIVE'),
    openingTime: time('opening_time').notNull().default('07:00:00'),
    closingTime: time('closing_time').notNull().default('20:00:00'),
    slotMinutes: integer('slot_minutes').notNull().default(30),
    minDurationMinutes: integer('min_duration_minutes').notNull().default(30),
    maxDurationMinutes: integer('max_duration_minutes').notNull().default(480),
    maxAdvanceDays: integer('max_advance_days').notNull().default(90),
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    locationIdx: index('mr_rooms_location_idx').on(t.locationId),
    capacityIdx: index('mr_rooms_capacity_idx').on(t.capacity),
  }),
);

export const roomEquipment = pgTable(
  'mr_room_equipment',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roomId, t.equipmentId] }) }),
);

export const roomBlackouts = pgTable(
  'mr_room_blackouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: varchar('reason', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ roomTimeIdx: index('mr_blackouts_room_time_idx').on(t.roomId, t.startsAt, t.endsAt) }),
);

export const reservations = pgTable(
  'mr_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: varchar('reference', { length: 24 }).notNull().unique(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    organizerId: uuid('organizer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 190 }).notNull(),
    description: varchar('description', { length: 2000 }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    attendeeCount: integer('attendee_count').notNull().default(1),
    status: reservationStatusEnum('status').notNull().default('CONFIRMED'),
    cancelledById: uuid('cancelled_by_id').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: varchar('cancellation_reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roomTimeIdx: index('mr_reservations_room_time_idx').on(t.roomId, t.startsAt, t.endsAt),
    organizerIdx: index('mr_reservations_organizer_idx').on(t.organizerId, t.startsAt),
  }),
);

export const reservationAttendees = pgTable(
  'mr_reservation_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    externalEmail: varchar('external_email', { length: 190 }),
    externalName: varchar('external_name', { length: 160 }),
    response: attendeeResponseEnum('response').notNull().default('INVITED'),
  },
  (t) => ({ userIdx: index('mr_attendees_user_idx').on(t.userId) }),
);

/* ========================================================================= */
/* Relations                                                                 */
/* ========================================================================= */

export const usersRelations = relations(users, ({ one, many }) => ({
  department: one(departments, { fields: [users.departmentId], references: [departments.id] }),
  roles: many(userRoles),
  reservations: many(reservations),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  users: many(userRoles),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  location: one(locations, { fields: [rooms.locationId], references: [locations.id] }),
  equipment: many(roomEquipment),
  reservations: many(reservations),
  blackouts: many(roomBlackouts),
}));

export const roomEquipmentRelations = relations(roomEquipment, ({ one }) => ({
  room: one(rooms, { fields: [roomEquipment.roomId], references: [rooms.id] }),
  equipment: one(equipment, { fields: [roomEquipment.equipmentId], references: [equipment.id] }),
}));

export const reservationsRelations = relations(reservations, ({ one, many }) => ({
  room: one(rooms, { fields: [reservations.roomId], references: [rooms.id] }),
  organizer: one(users, { fields: [reservations.organizerId], references: [users.id] }),
  attendees: many(reservationAttendees),
}));

export const reservationAttendeesRelations = relations(reservationAttendees, ({ one }) => ({
  reservation: one(reservations, {
    fields: [reservationAttendees.reservationId],
    references: [reservations.id],
  }),
  user: one(users, { fields: [reservationAttendees.userId], references: [users.id] }),
}));

/* ========================================================================= */
/* Inferred types                                                            */
/* ========================================================================= */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
