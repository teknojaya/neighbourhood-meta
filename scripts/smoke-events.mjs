// Charity events: real Meta drafting, suggestion vs confirmed needs, review/confirm creation,
// pledges and volunteer sign-ups with organizer management, privacy and cancellation.
// Local emulators and a loopback database only; removes its own fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { chromium } from 'playwright';
import { createDb } from '../apps/api/src/lib/db.ts';
import { stubMapTiles } from './map-test-tiles.mjs';
/* global document, innerWidth */

const base = process.env.SMOKE_API_URL ?? 'http://localhost:8080';
const web = process.env.SMOKE_WEB_URL ?? 'http://localhost:5173';
assert([base, web, process.env.DATABASE_URL].every(v => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(v).hostname)) && process.env.USE_FIREBASE_EMULATORS === 'true', 'Local emulators and database only');
const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID }, 'events-' + randomUUID());
const auth = getAuth(app), db = createDb(process.env.DATABASE_URL);
const out = path.resolve(process.env.SMOKE_SCREENSHOT_DIR ?? 'artifacts/ui/events'); await fs.mkdir(out, { recursive: true });
const HOME = { lat: -6.1951, lng: 106.8231 };
const people = []; let browser; let phase = 'setup';

async function person(name) {
  const uid = `events-smoke-${name}-${randomUUID().slice(0, 8)}`;
  await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
  const custom = await auth.createCustomToken(uid);
  const signed = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
  const p = { uid, custom, token: (await signed.json()).idToken };
  p.api = async (route, method = 'GET', body) => { const r = await fetch(base + '/api/v1' + route, { method, headers: { Authorization: 'Bearer ' + p.token, 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  await p.api('/me');
  await p.api('/me/profile', 'PUT', { displayName: `Events ${name}`, areaLabel: 'Menteng, Jakarta', homeLocation: HOME, searchRadiusKm: 3, preferredLanguage: 'en' });
  people.push(p); return p;
}
async function pageFor(p) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); await stubMapTiles(context);
  const page = await context.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(web + '/login');
  await page.evaluate(async t => { const { getFirebaseAuth } = await import('/src/lib/firebase.ts'); const { signInWithCustomToken } = await import('/node_modules/.vite/deps/firebase_auth.js'); await signInWithCustomToken(getFirebaseAuth(), t); }, p.custom);
  await page.waitForURL(url => url.pathname === '/'); return page;
}
async function shot(page, name) { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow on ${name}`); await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true }); }
const localInput = d => { const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

try {
  const organizer = await person('organizer'), alice = await person('alice'), bob = await person('bob');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

  phase = 'organizer drafts with the real Meta model';
  const op = await pageFor(organizer);
  await op.goto(web + '/events'); await op.getByRole('link', { name: 'Organise' }).click();
  await op.getByLabel('Describe your event in your own words').fill('Back-to-school supply drive this Saturday morning at our RT hall for children in Menteng. We need 30 notebooks and 2 people to help sort donations.');
  await op.getByRole('button', { name: 'Draft with AI' }).click();
  const suggestions = op.getByLabel('AI suggestions');
  await suggestions.waitFor({ timeout: 60_000 });
  await op.getByText('Suggested supply checklist — not added yet').waitFor();
  const draftText = await suggestions.innerText();
  console.log('  AI suggestions:', draftText.replace(/\s+/g, ' ').slice(0, 400));
  assert.match(draftText, /You mentioned/, 'Organizer-stated items are labelled');
  assert.equal(await op.getByLabel('Need 1').count(), 0, 'Suggestions are not needs until added');
  assert.notEqual(await op.getByLabel('Title *').inputValue(), '', 'Model drafted a title');
  await shot(op, 'draft-suggestions');
  // Keep only the stated notebooks; fill required facts the AI must not invent.
  const notebooks = suggestions.locator('li', { hasText: /notebook/i }).first();
  await notebooks.getByRole('button', { name: 'Add to needs' }).click();
  const need = op.getByLabel('Need 1');
  if (!(await need.getByLabel('Quantity').inputValue())) await need.getByLabel('Quantity').fill('30');
  assert.equal(await need.getByLabel('Quantity').inputValue(), '30', 'Stated quantity carried over');
  await op.getByRole('button', { name: 'Add volunteer slot' }).click();
  await op.getByLabel('Slot 1').getByLabel('Role').fill('Sorting table');
  await op.getByLabel('Slot 1').getByLabel('People').fill('1');
  const start = new Date(Date.now() + 2 * 86_400_000); start.setSeconds(0, 0);
  await op.getByLabel('Starts (your local time) *').fill(localInput(start));
  await op.getByLabel('Private drop-off note').fill('RT 05 hall, side door');
  await op.getByRole('button', { name: 'Review event' }).click();
  await op.getByRole('heading', { name: 'Review your event' }).waitFor();
  assert.equal(await db.charityEvent.count({ where: { organizer: { firebaseUid: organizer.uid } } }), 0, 'Nothing created before confirmation');
  await shot(op, 'review');
  await op.getByRole('button', { name: 'Create event' }).click();
  await op.waitForURL(url => /\/events\/[0-9a-f-]{36}$/.test(url.pathname));
  const eventId = op.url().split('/').at(-1);
  const stored = await db.charityEvent.findUniqueOrThrow({ where: { id: eventId }, include: { needs: true, slots: true } });
  assert.deepEqual({ lat: stored.lat, lng: stored.lng }, HOME, 'Uses the saved Profile coordinates');
  assert.equal(stored.needs.length, 1); assert.equal(stored.needs[0].quantity, 30); assert.equal(stored.slots[0].capacity, 1);
  assert.equal(stored.startsAt.toISOString(), start.toISOString());

  phase = 'neighbour pledges after review; volunteer capacity';
  const ap = await pageFor(alice);
  await ap.goto(web + '/events'); await ap.getByRole('link', { name: new RegExp(stored.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
  await ap.getByText('The exact drop-off point is shared once').waitFor();
  await ap.getByRole('button', { name: /^Pledge / }).click();
  await ap.getByLabel(/How many\?/).fill('5');
  await ap.getByRole('button', { name: 'Review pledge' }).click();
  await ap.getByText('a pledge alone is not proof of delivery').waitFor();
  assert.equal(await db.eventPledge.count({ where: { eventId } }), 0, 'Pledge needs explicit confirmation');
  await ap.getByRole('button', { name: 'Confirm', exact: true }).click();
  await ap.getByText('Pledged — awaiting organizer').waitFor();
  await ap.getByText('5 of 30 pledged').waitFor();
  assert.equal((await bob.api(`/events/${eventId}/slots/${stored.slots[0].id}/signups`, 'POST', {})).status, 201);
  await ap.reload(); await ap.getByText('1 of 1 places taken').waitFor();
  assert.equal(await ap.getByRole('button', { name: 'Volunteer' }).count(), 0, 'Full slot offers no sign-up');
  assert.equal((await alice.api(`/events/${eventId}/slots/${stored.slots[0].id}/signups`, 'POST', {})).status, 409, 'Server enforces capacity');
  assert.equal((await alice.api(`/events/${eventId}/pledges`, 'POST', { needId: stored.needs[0].id, quantity: 26, note: '' })).status, 409, 'Server enforces quantity');
  await shot(ap, 'neighbour-pledged');

  phase = 'organizer accepts and receives; contributor gains private details';
  await op.reload(); await op.getByText('Contributions').waitFor();
  await op.getByRole('button', { name: 'Accept' }).first().click(); await op.getByText('Accepted — bring it to the event').waitFor();
  await op.getByRole('button', { name: 'Mark received' }).click(); await op.getByText('Received by organizer').waitFor();
  await op.getByText('5 of 30 pledged · 5 received').waitFor();
  await shot(op, 'organizer-managing');
  await ap.reload(); await ap.getByText('Private drop-off details').waitFor(); await ap.getByText('RT 05 hall, side door').waitFor();
  const bobView = (await bob.api(`/events/${eventId}`)).body;
  assert.equal(bobView.privateLocation, null, 'Pending volunteer does not see the exact point');
  assert(bobView.pledges.length === 0 && bobView.signups.every(s => s.contributorName === null), 'Others’ contributions stay private');

  phase = 'organizer cancels; statuses and notices';
  await op.getByRole('button', { name: 'Cancel event' }).click();
  await op.getByRole('button', { name: 'Yes, cancel event' }).click();
  await op.getByText('This event was cancelled.').waitFor();
  const after = (await organizer.api(`/events/${eventId}`)).body;
  assert.deepEqual(after.pledges.map(p => p.status), ['received']); assert.deepEqual(after.signups.map(s => s.status), ['cancelled']);
  const bp = await pageFor(bob); await bp.goto(web + '/notifications'); await bp.getByText('Event cancelled').first().waitFor();
  await shot(bp, 'notifications');
  assert.equal([...op.errors, ...ap.errors, ...bp.errors].length, 0, [...op.errors, ...ap.errors, ...bp.errors].join('\n'));
  console.log('smoke:events passed; screenshots in', out);
} catch (error) {
  console.error(`smoke:events failed during ${phase}`); throw error;
} finally {
  await browser?.close();
  const ids = (await db.user.findMany({ where: { firebaseUid: { in: people.map(p => p.uid) } }, select: { id: true } })).map(u => u.id);
  await db.charityEvent.deleteMany({ where: { organizerId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.idempotencyKey.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await Promise.all(people.map(p => auth.deleteUser(p.uid).catch(() => undefined)));
  await db.$disconnect(); await deleteApp(app);
}
