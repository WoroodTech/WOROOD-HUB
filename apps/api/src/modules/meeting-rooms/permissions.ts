/**
 * Permission keys for Module 1, in one place so the descriptor, the guards and
 * the services cannot drift apart on a string literal.
 */
export const MR_PERMISSIONS = {
  ROOM_MANAGE: 'meeting-rooms.room.manage',
  MANAGE_ANY: 'meeting-rooms.reservation.manage-any',
} as const;
