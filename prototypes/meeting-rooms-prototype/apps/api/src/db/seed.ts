/**
 * Seeds a demo-ready WOROOD HUB: RBAC derived from the module registry,
 * departments, employees, three office sites, eight meeting rooms and a
 * handful of reservations spread across the coming week.
 *
 *   npm run db:seed
 */
import 'reflect-metadata';
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from './client';
import {
  departments,
  equipment,
  locations,
  permissions,
  reservations,
  reservationAttendees,
  rolePermissions,
  roles,
  roomEquipment,
  rooms,
  userRoles,
  users,
} from './schema';
import '../modules/meeting-rooms/meeting-rooms.descriptor';
import { getAllPermissionDefinitions } from '../core/hub/module-registry';
import { MR_PERMISSIONS } from '../modules/meeting-rooms/meeting-rooms.descriptor';

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Worood@2026';

/** Role definitions. Permissions are looked up by key from the registry. */
const ROLE_DEFINITIONS = [
  {
    key: 'employee',
    name: 'Employee',
    description: 'Every member of staff. Can find and book rooms.',
    permissions: [MR_PERMISSIONS.ROOM_READ, MR_PERMISSIONS.RESERVATION_CREATE],
  },
  {
    key: 'facilities',
    name: 'Facilities Coordinator',
    description: 'Manages the room catalogue and can adjust any booking.',
    permissions: [
      MR_PERMISSIONS.ROOM_READ,
      MR_PERMISSIONS.ROOM_MANAGE,
      MR_PERMISSIONS.RESERVATION_CREATE,
      MR_PERMISSIONS.RESERVATION_READ_ALL,
      MR_PERMISSIONS.RESERVATION_MANAGE_ALL,
    ],
  },
  {
    key: 'admin',
    name: 'System Administrator',
    description: 'Full access across every module.',
    permissions: Object.values(MR_PERMISSIONS),
  },
];

function at(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function reference(start: Date, suffix: string): string {
  return `MR-${start.toISOString().slice(0, 10).replace(/-/g, '')}-${suffix}`;
}

async function main() {
  console.log('Seeding WOROOD HUB …');

  await db.transaction(async (tx) => {
    /* ------------------------------------------------------------------ */
    /* 1. Permissions — every module contributes its own                    */
    /* ------------------------------------------------------------------ */
    const permissionDefs = getAllPermissionDefinitions();
    for (const def of permissionDefs) {
      await tx
        .insert(permissions)
        .values({ key: def.key, moduleKey: def.moduleKey, description: def.description })
        .onConflictDoUpdate({
          target: permissions.key,
          set: { description: def.description, moduleKey: def.moduleKey },
        });
    }
    const allPermissions = await tx.select().from(permissions);
    const permissionByKey = new Map(allPermissions.map((p) => [p.key, p.id]));
    console.log(`  ✓ ${allPermissions.length} permissions`);

    /* ------------------------------------------------------------------ */
    /* 2. Roles                                                            */
    /* ------------------------------------------------------------------ */
    const roleByKey = new Map<string, string>();
    for (const def of ROLE_DEFINITIONS) {
      const [role] = await tx
        .insert(roles)
        .values({ key: def.key, name: def.name, description: def.description, isSystem: true })
        .onConflictDoUpdate({ target: roles.key, set: { name: def.name, description: def.description } })
        .returning();
      roleByKey.set(def.key, role.id);

      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
      const rows = def.permissions
        .map((key) => permissionByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId }));
      if (rows.length) await tx.insert(rolePermissions).values(rows);
    }
    console.log(`  ✓ ${ROLE_DEFINITIONS.length} roles`);

    /* ------------------------------------------------------------------ */
    /* 3. Departments                                                      */
    /* ------------------------------------------------------------------ */
    const departmentDefs = [
      { code: 'IT', name: 'Information Technology', nameAr: 'تقنية المعلومات' },
      { code: 'HR', name: 'Human Resources', nameAr: 'الموارد البشرية' },
      { code: 'FIN', name: 'Finance', nameAr: 'المالية' },
      { code: 'OPS', name: 'Operations', nameAr: 'العمليات' },
      { code: 'FAC', name: 'Facilities', nameAr: 'الخدمات المساندة' },
      { code: 'SLS', name: 'Sales & Marketing', nameAr: 'المبيعات والتسويق' },
    ];
    const departmentByCode = new Map<string, string>();
    for (const def of departmentDefs) {
      const [row] = await tx
        .insert(departments)
        .values(def)
        .onConflictDoUpdate({ target: departments.code, set: { name: def.name } })
        .returning();
      departmentByCode.set(def.code, row.id);
    }
    console.log(`  ✓ ${departmentDefs.length} departments`);

    /* ------------------------------------------------------------------ */
    /* 4. Employees                                                        */
    /* ------------------------------------------------------------------ */
    const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 12);
    const userDefs = [
      { employeeNo: 'W-1001', email: 'admin@worood.co', fullName: 'Portal Administrator', fullNameAr: 'مدير البوابة', jobTitle: 'IT Manager', dept: 'IT', role: 'admin' },
      { employeeNo: 'W-1002', email: 'facilities@worood.co', fullName: 'Hala Mansour', fullNameAr: 'هالة منصور', jobTitle: 'Facilities Coordinator', dept: 'FAC', role: 'facilities' },
      { employeeNo: 'W-1003', email: 'omar.khaled@worood.co', fullName: 'Omar Khaled', fullNameAr: 'عمر خالد', jobTitle: 'Senior Accountant', dept: 'FIN', role: 'employee' },
      { employeeNo: 'W-1004', email: 'sara.ibrahim@worood.co', fullName: 'Sara Ibrahim', fullNameAr: 'سارة إبراهيم', jobTitle: 'HR Business Partner', dept: 'HR', role: 'employee' },
      { employeeNo: 'W-1005', email: 'youssef.adel@worood.co', fullName: 'Youssef Adel', fullNameAr: 'يوسف عادل', jobTitle: 'Operations Lead', dept: 'OPS', role: 'employee' },
      { employeeNo: 'W-1006', email: 'nour.hassan@worood.co', fullName: 'Nour Hassan', fullNameAr: 'نور حسن', jobTitle: 'Marketing Specialist', dept: 'SLS', role: 'employee' },
      { employeeNo: 'W-1007', email: 'karim.fouad@worood.co', fullName: 'Karim Fouad', fullNameAr: 'كريم فؤاد', jobTitle: 'Software Engineer', dept: 'IT', role: 'employee' },
    ];

    const userByEmail = new Map<string, string>();
    for (const def of userDefs) {
      const [row] = await tx
        .insert(users)
        .values({
          employeeNo: def.employeeNo,
          email: def.email,
          passwordHash,
          fullName: def.fullName,
          fullNameAr: def.fullNameAr,
          jobTitle: def.jobTitle,
          departmentId: departmentByCode.get(def.dept),
          timezone: 'Africa/Cairo',
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { fullName: def.fullName, jobTitle: def.jobTitle, passwordHash },
        })
        .returning();
      userByEmail.set(def.email, row.id);

      await tx.delete(userRoles).where(eq(userRoles.userId, row.id));
      const roleId = roleByKey.get(def.role);
      if (roleId) await tx.insert(userRoles).values({ userId: row.id, roleId });
    }
    console.log(`  ✓ ${userDefs.length} employees (password: ${DEMO_PASSWORD})`);

    /* ------------------------------------------------------------------ */
    /* 5. Sites                                                            */
    /* ------------------------------------------------------------------ */
    const locationDefs = [
      { code: 'HQ', name: 'Head Office', nameAr: 'المقر الرئيسي', building: 'Worood Tower', address: 'New Cairo, Egypt', timezone: 'Africa/Cairo' },
      { code: 'BR1', name: 'Downtown Branch', nameAr: 'فرع وسط البلد', building: 'Nile Plaza', address: 'Downtown Cairo, Egypt', timezone: 'Africa/Cairo' },
      { code: 'WH', name: 'Logistics Centre', nameAr: 'مركز اللوجستيات', building: 'Warehouse A', address: '6th of October City, Egypt', timezone: 'Africa/Cairo' },
    ];
    const locationByCode = new Map<string, string>();
    for (const def of locationDefs) {
      const [row] = await tx
        .insert(locations)
        .values(def)
        .onConflictDoUpdate({ target: locations.code, set: { name: def.name } })
        .returning();
      locationByCode.set(def.code, row.id);
    }

    /* ------------------------------------------------------------------ */
    /* 6. Equipment catalogue                                              */
    /* ------------------------------------------------------------------ */
    const equipmentDefs = [
      { key: 'projector', name: 'Projector', nameAr: 'جهاز عرض', icon: 'projector' },
      { key: 'tv-screen', name: 'TV Screen', nameAr: 'شاشة عرض', icon: 'tv' },
      { key: 'video-conference', name: 'Video Conference', nameAr: 'مؤتمر مرئي', icon: 'video' },
      { key: 'whiteboard', name: 'Whiteboard', nameAr: 'سبورة', icon: 'edit' },
      { key: 'conference-phone', name: 'Conference Phone', nameAr: 'هاتف اجتماعات', icon: 'phone' },
      { key: 'flipchart', name: 'Flipchart', nameAr: 'لوح ورقي', icon: 'clipboard' },
      { key: 'wireless-hdmi', name: 'Wireless HDMI', nameAr: 'اتصال لاسلكي', icon: 'cast' },
    ];
    const equipmentByKey = new Map<string, string>();
    for (const def of equipmentDefs) {
      const [row] = await tx
        .insert(equipment)
        .values(def)
        .onConflictDoUpdate({ target: equipment.key, set: { name: def.name } })
        .returning();
      equipmentByKey.set(def.key, row.id);
    }
    console.log(`  ✓ ${locationDefs.length} sites, ${equipmentDefs.length} equipment types`);

    /* ------------------------------------------------------------------ */
    /* 7. Rooms                                                            */
    /* ------------------------------------------------------------------ */
    const roomDefs = [
      { code: 'HQ-BR-01', name: 'Boardroom', nameAr: 'قاعة مجلس الإدارة', loc: 'HQ', floor: '10th Floor', capacity: 20, description: 'Executive boardroom with full video-conference suite and city view.', equipment: ['projector', 'video-conference', 'conference-phone', 'whiteboard'], openingTime: '08:00:00', closingTime: '19:00:00', bufferMinutes: 15, maxDurationMinutes: 300 },
      { code: 'HQ-JASMINE', name: 'Jasmine Room', nameAr: 'قاعة الياسمين', loc: 'HQ', floor: '9th Floor', capacity: 12, description: 'Bright meeting room suited to workshops and interviews.', equipment: ['tv-screen', 'whiteboard', 'wireless-hdmi'] },
      { code: 'HQ-LOTUS', name: 'Lotus Room', nameAr: 'قاعة اللوتس', loc: 'HQ', floor: '9th Floor', capacity: 8, description: 'Standard meeting room with screen sharing.', equipment: ['tv-screen', 'wireless-hdmi'] },
      { code: 'HQ-FOCUS-1', name: 'Focus Room 1', nameAr: 'غرفة التركيز ١', loc: 'HQ', floor: '8th Floor', capacity: 4, description: 'Small huddle space for quick catch-ups and calls.', equipment: ['conference-phone', 'whiteboard'], minDurationMinutes: 15, slotMinutes: 15 },
      { code: 'HQ-FOCUS-2', name: 'Focus Room 2', nameAr: 'غرفة التركيز ٢', loc: 'HQ', floor: '8th Floor', capacity: 4, description: 'Small huddle space next to the Finance wing.', equipment: ['conference-phone'], minDurationMinutes: 15, slotMinutes: 15 },
      { code: 'HQ-TRAIN', name: 'Training Hall', nameAr: 'قاعة التدريب', loc: 'HQ', floor: '2nd Floor', capacity: 40, description: 'Large training space with staged seating.', equipment: ['projector', 'flipchart', 'whiteboard', 'conference-phone'], requiresApproval: false, maxDurationMinutes: 480 },
      { code: 'BR1-MEET-1', name: 'Nile Meeting Room', nameAr: 'قاعة النيل', loc: 'BR1', floor: '3rd Floor', capacity: 10, description: 'Branch meeting room overlooking the Nile.', equipment: ['tv-screen', 'video-conference'] },
      { code: 'WH-OPS', name: 'Operations Room', nameAr: 'قاعة العمليات', loc: 'WH', floor: 'Ground Floor', capacity: 6, description: 'Practical room beside the warehouse floor.', equipment: ['whiteboard', 'flipchart'], openingTime: '06:00:00', closingTime: '18:00:00' },
    ];

    const roomByCode = new Map<string, string>();
    for (const def of roomDefs) {
      const [row] = await tx
        .insert(rooms)
        .values({
          code: def.code,
          name: def.name,
          nameAr: def.nameAr,
          locationId: locationByCode.get(def.loc)!,
          floor: def.floor,
          capacity: def.capacity,
          description: def.description,
          openingTime: def.openingTime,
          closingTime: def.closingTime,
          bufferMinutes: def.bufferMinutes,
          minDurationMinutes: def.minDurationMinutes,
          maxDurationMinutes: def.maxDurationMinutes,
          slotMinutes: def.slotMinutes,
          requiresApproval: def.requiresApproval,
        })
        .onConflictDoUpdate({
          target: rooms.code,
          set: { name: def.name, capacity: def.capacity, description: def.description },
        })
        .returning();
      roomByCode.set(def.code, row.id);

      await tx.delete(roomEquipment).where(eq(roomEquipment.roomId, row.id));
      await tx.insert(roomEquipment).values(
        def.equipment.map((key) => ({ roomId: row.id, equipmentId: equipmentByKey.get(key)!, quantity: 1 })),
      );
    }
    console.log(`  ✓ ${roomDefs.length} meeting rooms`);

    /* ------------------------------------------------------------------ */
    /* 8. Sample reservations                                              */
    /* ------------------------------------------------------------------ */
    await tx.delete(reservationAttendees);
    await tx.delete(reservations);

    const reservationDefs = [
      { room: 'HQ-BR-01', organizer: 'admin@worood.co', title: 'Quarterly Business Review', start: at(1, 10), end: at(1, 12), attendees: ['omar.khaled@worood.co', 'sara.ibrahim@worood.co'], count: 14 },
      { room: 'HQ-JASMINE', organizer: 'sara.ibrahim@worood.co', title: 'Graduate Interviews', start: at(1, 9), end: at(1, 11), attendees: ['nour.hassan@worood.co'], count: 5 },
      { room: 'HQ-LOTUS', organizer: 'karim.fouad@worood.co', title: 'HUB Sprint Planning', start: at(0, 14), end: at(0, 15, 30), attendees: ['admin@worood.co'], count: 6 },
      { room: 'HQ-TRAIN', organizer: 'facilities@worood.co', title: 'Fire Safety Training', start: at(2, 9), end: at(2, 13), attendees: [], count: 35 },
      { room: 'BR1-MEET-1', organizer: 'youssef.adel@worood.co', title: 'Branch Operations Sync', start: at(2, 11), end: at(2, 12), attendees: ['facilities@worood.co'], count: 7 },
      { room: 'HQ-FOCUS-1', organizer: 'nour.hassan@worood.co', title: 'Campaign Check-in', start: at(3, 13), end: at(3, 13, 30), attendees: [], count: 3 },
      { room: 'HQ-JASMINE', organizer: 'omar.khaled@worood.co', title: 'Budget Walkthrough (last week)', start: at(-6, 10), end: at(-6, 11), attendees: ['admin@worood.co'], count: 8 },
      { room: 'HQ-LOTUS', organizer: 'admin@worood.co', title: 'Vendor Demo (last week)', start: at(-4, 15), end: at(-4, 16), attendees: [], count: 4 },
    ];

    let index = 0;
    for (const def of reservationDefs) {
      const [row] = await tx
        .insert(reservations)
        .values({
          reference: reference(def.start, `S${String(++index).padStart(3, '0')}`),
          roomId: roomByCode.get(def.room)!,
          organizerId: userByEmail.get(def.organizer)!,
          title: def.title,
          startsAt: def.start,
          endsAt: def.end,
          attendeeCount: def.count,
          status: def.end < new Date() ? 'COMPLETED' : 'CONFIRMED',
        })
        .returning();

      if (def.attendees.length) {
        await tx.insert(reservationAttendees).values(
          def.attendees.map((email) => ({ reservationId: row.id, userId: userByEmail.get(email)! })),
        );
      }
    }
    console.log(`  ✓ ${reservationDefs.length} sample reservations`);
  });

  const [{ rooms: roomCount }] = (await db.execute(sql`SELECT count(*)::int AS rooms FROM mr_rooms`)).rows as any;
  console.log(`\nSeed complete — ${roomCount} rooms ready.`);
  console.log('Sign in with  admin@worood.co  /  ' + DEMO_PASSWORD);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
