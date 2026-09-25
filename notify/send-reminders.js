// Daily due-date push reminders for the To-do Notebook app.
// Runs on GitHub Actions (see .github/workflows/due-reminders.yml).
// Free: Web Push has no per-message cost; the scheduler is a GitHub Actions cron.
//
// What it does, once a day (~7am America/Edmonton):
//   1. Signs in to Firebase anonymously (same as the web app) and reads the
//      shared todoApp/shared document.
//   2. Finds tasks that are overdue, due today, or due tomorrow and haven't
//      been reminded about yet today.
//   3. Sends one Web Push notification to every stored push subscription.
//   4. Records which tasks were reminded about (todo:push-notified:<date>)
//      and prunes dead subscriptions (expired endpoints).

const FIREBASE_API_KEY = 'AIzaSyCYnhF0e0eulW8kJNJrebG5-2K2_KItNrY'; // public web key, also in index.html
const PROJECT_ID = 'todo-app-87ed7';
const DOC = 'todoApp/shared';
const TASKS_KEY = 'todo:tasks';
const SUBS_KEY = 'todo:push-subscriptions';

// Must match VAPID_PUBLIC_KEY in index.html
const VAPID_PUBLIC_KEY = 'BDRv_mGOw2gYzHgHYj65rl5suCfeotXhC8SNKFmmsC6mf9rP9ru3_gzoDHj9vGh-k-PMfw9hnZmM4hM4qwZK6so';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:todo-app@example.com';
const DRY_RUN = process.env.DRY_RUN === '1';

const webpush = require('web-push');

function edmontonToday() {
  // YYYY-MM-DD in America/Edmonton
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

async function anonIdToken() {
  // Empty-body signUp creates an anonymous user via the REST API.
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.idToken;
}

const docUrl = () =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC}`;

async function readDoc(idToken) {
  const res = await fetch(docUrl(), { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) throw new Error(`firestore read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.fields || {};
}

function strVal(fields, key) {
  const f = fields[key];
  return f && f.stringValue !== undefined ? f.stringValue : null;
}

async function writeFields(idToken, map) {
  // map: { fieldName: stringValue }. Field names contain colons, so they are
  // backtick-quoted in the update mask (Firestore field-path syntax).
  const params = new URLSearchParams();
  for (const k of Object.keys(map)) params.append('updateMask.fieldPaths', '`' + k + '`');
  const body = { fields: {} };
  for (const [k, v] of Object.entries(map)) body.fields[k] = { stringValue: v };
  const res = await fetch(docUrl() + '?' + params.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`firestore write failed: ${res.status} ${await res.text()}`);
}

function taskLabel(t) {
  const meta = [t.course, t.weight].filter(Boolean).join(' · ');
  return t.text + (meta ? ` (${meta})` : '');
}

async function main() {
  if (!VAPID_PRIVATE_KEY && !DRY_RUN) throw new Error('VAPID_PRIVATE_KEY env var is required');
  if (VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const idToken = await anonIdToken();
  const fields = await readDoc(idToken);

  const tasksRaw = strVal(fields, TASKS_KEY);
  const tasks = tasksRaw ? JSON.parse(tasksRaw) : [];
  const subsRaw = strVal(fields, SUBS_KEY);
  let subs = subsRaw ? JSON.parse(subsRaw) : [];
  if (!Array.isArray(subs)) subs = [];

  const today = edmontonToday();
  const tomorrow = addDays(today, 1);
  const notifiedKey = `todo:push-notified:${today}`;
  const alreadyRaw = strVal(fields, notifiedKey);
  const already = new Set(alreadyRaw ? JSON.parse(alreadyRaw) : []);

  const overdue = [], dueToday = [], dueTomorrow = [];
  for (const t of tasks) {
    if (t.done || !t.due || already.has(t.id)) continue;
    if (t.due < today) overdue.push(t);
    else if (t.due === today) dueToday.push(t);
    else if (t.due === tomorrow) dueTomorrow.push(t);
  }
  const fresh = [...overdue, ...dueToday, ...dueTomorrow];

  if (!fresh.length) {
    console.log(`[${today}] nothing new to remind about.`);
    return;
  }
  if (!subs.length) {
    console.log(`[${today}] ${fresh.length} task(s) need reminders but no push subscriptions are stored yet.`);
    console.log('Tasks:', fresh.map(taskLabel).join(' | '));
    return;
  }

  const lines = [];
  if (overdue.length) lines.push('Overdue: ' + overdue.map(taskLabel).join(', '));
  if (dueToday.length) lines.push('Due today: ' + dueToday.map(taskLabel).join(', '));
  if (dueTomorrow.length) lines.push('Due tomorrow: ' + dueTomorrow.map(taskLabel).join(', '));
  const title = fresh.length === 1 ? 'Task due' : `${fresh.length} tasks due`;
  const body = lines.join('\n').slice(0, 500);
  const payload = JSON.stringify({ title, body });

  console.log(`[${today}] notifying ${subs.length} subscription(s): ${title}`);
  console.log(body);

  const dead = [];
  if (!DRY_RUN) {
    const results = await Promise.allSettled(subs.map(sub => webpush.sendNotification(sub, payload)));
    results.forEach((r, i) => {
      const sub = subs[i];
      if (r.status === 'fulfilled') {
        console.log(`sent -> ${sub.endpoint.slice(0, 60)}...`);
      } else {
        const e = r.reason || {};
        console.error(`send failed (${e.statusCode}): ${sub.endpoint.slice(0, 60)}...`);
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      }
    });
  } else {
    console.log('[dry run] skipping actual push send');
  }

  const writes = {};
  writes[notifiedKey] = JSON.stringify([...already, ...fresh.map(t => t.id)]);
  if (dead.length) {
    subs = subs.filter(s => !dead.includes(s.endpoint));
    writes[SUBS_KEY] = JSON.stringify(subs);
    console.log(`pruned ${dead.length} dead subscription(s)`);
  }
  if (!DRY_RUN) {
    await writeFields(idToken, writes);
    console.log('reminder state saved');
  } else {
    console.log('[dry run] skipping state write');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
