// scripts/test-event-autocomplete.mjs
// Test the event auto-complete predicate wrap fix (bug C20). getTasksForDate auto-completes past
// events; time(event_time,'+1 hour') wraps for a 23:xx event (23:30 -> 00:30), which used to make
// a late-night event auto-complete all morning before it happened. This mirrors the shipped WHERE
// clause but binds :now instead of time('now','localtime') so we can assert behaviour at fixed
// clock times deterministically (better-sqlite3, in-memory).
//
// Run: node scripts/test-event-autocomplete.mjs

import Database from 'better-sqlite3'

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`)
}

const db = new Database(':memory:')
db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, task_type TEXT, status TEXT, due_date TEXT, event_time TEXT, end_time TEXT)`)

const TODAY = '2026-07-13'
const YESTERDAY = '2026-07-12'
db.prepare(`INSERT INTO tasks VALUES ('normal', 'event', 'active', ?, '14:00', NULL)`).run(TODAY)
db.prepare(`INSERT INTO tasks VALUES ('late',   'event', 'active', ?, '23:30', NULL)`).run(TODAY)
db.prepare(`INSERT INTO tasks VALUES ('cross',  'event', 'active', ?, '23:00', '00:30')`).run(TODAY)
db.prepare(`INSERT INTO tasks VALUES ('past',   'event', 'active', ?, '10:00', NULL)`).run(YESTERDAY)

// The fixed predicate, with :now standing in for time('now','localtime').
const sel = db.prepare(`
  SELECT id FROM tasks
  WHERE task_type = 'event' AND status NOT IN ('done','archived')
  AND (
    (due_date IS NOT NULL AND due_date < :date)
    OR (due_date = :date AND event_time IS NOT NULL
        AND time(COALESCE(end_time, time(event_time, '+1 hour'))) >= time(event_time)
        AND time(COALESCE(end_time, time(event_time, '+1 hour'))) <= time(:now))
  )
`)
const completedAt = (now) => new Set(sel.all({ date: TODAY, now }).map(r => r.id))

// Morning (08:00): only yesterday's event should auto-complete. The late/cross events must NOT.
const morning = completedAt('08:00')
check('C20: late 23:30 event NOT auto-completed in the morning', morning.has('late'), false)
check('C20: cross-midnight event NOT auto-completed in the morning', morning.has('cross'), false)
check('normal 14:00 event NOT yet completed at 08:00', morning.has('normal'), false)
check('yesterday event IS auto-completed (past-day branch)', morning.has('past'), true)

// After the normal event ends (15:30): it completes; late/cross still must not (end is next-day).
const afternoon = completedAt('15:30')
check('normal event auto-completed after its end', afternoon.has('normal'), true)
check('late event still not completed at 15:30', afternoon.has('late'), false)

// Late evening (23:45): the 23:30–00:30 event is still ongoing → must NOT complete on its own date.
const lateEve = completedAt('23:45')
check('C20: late event still not completed at 23:45 (ends next day)', lateEve.has('late'), false)
check('C20: cross-midnight event still not completed at 23:45', lateEve.has('cross'), false)

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll event-autocomplete (C20) tests passed.')
