/** The calendar endpoint over a range. */
import { query, one, closeDb } from '../src/common/db';
import { ReservationsService } from '../src/modules/meeting-rooms/reservations.service';

let pass=0, fail=0;
const ok=(n:string,c:boolean,d='')=>{c?(pass++,console.log('  ok    '+n)):(fail++,console.log('  FAIL  '+n+' '+d));};
const eq=(n:string,a:any,b:any)=>ok(n,JSON.stringify(a)===JSON.stringify(b),`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);

async function main(){
  const loc = await one<any>(
    `INSERT INTO mr_locations (name, code, iana_timezone)
     VALUES ('Cairo HQ','WK-HQ','Africa/Cairo') RETURNING id`);
  const room = await one<any>(
    `INSERT INTO mr_rooms (name, code, location_id, capacity, opens_at, closes_at, buffer_minutes)
     VALUES ('Week probe','WK-R1', $1, 8, '08:00', '20:00', 15) RETURNING id`, [loc.id]);
  const user = await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name)
     VALUES ('wk@example.invalid','x','Week Probe') RETURNING id`);

  // one booking on day 0, one on day 3
  for (const [d,h] of [[0,10],[3,14]] as [number,number][]) {
    const day = new Date(Date.UTC(2026,10,7+d,h-2,0,0)); // Cairo = UTC+2
    await query(
      `INSERT INTO mr_reservations (room_id, organizer_id, title, starts_at, ends_at, status, reference)
       VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6)`,
      [room.id, user.id, `Meeting d${d}`, day, new Date(day.getTime()+3600_000), `WK-${d}`]);
  }

  const svc = new ReservationsService({ get: async () => ({
    id: room.id, name: 'Week probe', nameAr: null, opensAt: '08:00', closesAt: '20:00',
    bufferMinutes: 15, location: { timezone: 'Africa/Cairo' },
  }) } as any, {} as any, {} as any);

  console.log('\nA week in one request');
  const wk:any = await svc.calendar({ id: user.id } as any, room.id, '2026-11-07', 7);
  eq('seven days come back', wk.days.length, 7);
  eq('in order, starting where asked', wk.days[0].date, '2026-11-07');
  eq('and ending six days later', wk.days[6].date, '2026-11-13');
  ok('the booking on day 0 is there', wk.days[0].blocks.some((b:any)=>b.type==='BOOKING'));
  ok('and the one on day 3', wk.days[3].blocks.some((b:any)=>b.type==='BOOKING'));
  ok('empty days are present, not omitted', wk.days[1].blocks.length===0 || wk.days[1].blocks.every((b:any)=>b.type!=='BOOKING'));

  console.log('\nA single day still works the same way');
  const one_:any = await svc.calendar({ id: user.id } as any, room.id, '2026-11-07');
  eq('one entry', one_.days.length, 1);
  eq('same blocks as the week view gives for that day',
     one_.days[0].blocks.length, wk.days[0].blocks.length);

  console.log('\nBuffers survive the range');
  ok('a changeover buffer is emitted around the booking',
     wk.days[0].blocks.some((b:any)=>b.type==='BUFFER'), JSON.stringify(wk.days[0].blocks.map((b:any)=>b.type)));

  await query(`DELETE FROM mr_reservations WHERE room_id=$1`,[room.id]);
  await query(`DELETE FROM mr_rooms WHERE id=$1`,[room.id]);
  await query(`DELETE FROM mr_locations WHERE id=$1`,[loc.id]);
  await query(`DELETE FROM core_users WHERE id=$1`,[user.id]);
  console.log(`\n${pass+fail} assertions: ${pass} passed, ${fail} failed`);
  await closeDb(); process.exit(fail?1:0);
}
main().catch(async(e)=>{console.error(e);await closeDb();process.exit(1);});