// Surplus-food rescue: real browser form, collect-by display, deadline enforcement,
// expiry maintenance and real Meta model drafting through the Ask review/Confirm flow.
// Local emulators and a loopback database only; removes its own fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { chromium } from 'playwright';
import { createDb } from '../apps/api/src/lib/db.ts';
import { MaintenanceService } from '../apps/api/src/modules/notifications/maintenance.service.ts';
import { stubMapTiles } from './map-test-tiles.mjs';
/* global document, innerWidth */

const base = process.env.SMOKE_API_URL ?? 'http://localhost:8080';
const web = process.env.SMOKE_WEB_URL ?? 'http://localhost:5173';
assert([base, web, process.env.DATABASE_URL].every(value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) && process.env.USE_FIREBASE_EMULATORS === 'true', 'Local emulators and database only');
const skipAi = process.env.SMOKE_SKIP_AI === 'true';
const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID }, 'food-' + randomUUID());
const auth = getAuth(app), db = createDb(process.env.DATABASE_URL);
const out = path.resolve(process.env.SMOKE_SCREENSHOT_DIR ?? 'artifacts/ui/food-rescue'); await fs.mkdir(out, { recursive: true });
const HOME = { lat: -6.2441, lng: 106.8451 };
const people = {}; let browser; let phase = 'setup';

async function person(name) {
  const uid = `food-smoke-${name}-${randomUUID().slice(0, 8)}`;
  await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
  const custom = await auth.createCustomToken(uid);
  const signed = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
  const p = { uid, custom, token: (await signed.json()).idToken };
  p.api = async (route, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + '/api/v1' + route, { method, headers: { Authorization: 'Bearer ' + p.token, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}), ...headers }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
    const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  p.id = (await p.api('/me')).body.userId ?? (await db.user.findFirstOrThrow({ where: { firebaseUid: uid } })).id;
  await p.api('/me/profile', 'PUT', { displayName: `Food ${name}`, areaLabel: 'Tebet, Jakarta', homeLocation: HOME, searchRadiusKm: 3, preferredLanguage: 'en' });
  p.dbId = (await db.user.findFirstOrThrow({ where: { firebaseUid: uid } })).id;
  people[name] = p; return p;
}
async function pageFor(p) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); await stubMapTiles(context);
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.errors = errors;
  await page.goto(web + '/login');
  await page.evaluate(async t => { const { getFirebaseAuth } = await import('/src/lib/firebase.ts'); const { signInWithCustomToken } = await import('/node_modules/.vite/deps/firebase_auth.js'); await signInWithCustomToken(getFirebaseAuth(), t); }, p.custom);
  await page.waitForURL(url => url.pathname === '/'); return page;
}
async function shot(page, name) { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow on ${name}`); await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true }); }
const localInput = date => { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };

try {
  const giver = await person('giver'), neighbour = await person('neighbour');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

  phase = 'form: publish a food rescue offer';
  const gp = await pageFor(giver);
  await gp.goto(web + '/share');
  await gp.getByLabel(/Surplus food rescue/).check();
  const title = 'Surplus nasi boxes ' + giver.uid.slice(-6);
  await gp.getByLabel('Item Title *').fill(title);
  await gp.getByLabel('Quantity Available *').fill('3');
  const deadline = new Date(Date.now() + 2 * 3_600_000 + 10 * 60_000); deadline.setSeconds(0, 0);
  await gp.getByLabel('Collect by (your local time) *').fill(localInput(deadline));
  await gp.getByLabel('Allergens, if known').fill('Contains egg and peanuts');
  await gp.getByLabel('Item photo (required)').setInputFiles('apps/api/seed-assets/products/nasi-goreng.jpg');
  assert(await gp.locator('#listing-field-0').isDisabled(), 'Category is locked to groceries for food rescue');
  await shot(gp, 'form');
  await gp.getByRole('button', { name: 'Publish Listing', exact: true }).click();
  await gp.waitForURL(url => url.pathname === '/activity', { timeout: 30_000 });
  const listing = await db.listing.findFirstOrThrow({ where: { ownerId: giver.dbId, title } });
  assert.equal(listing.foodRescue, true); assert.equal(listing.status, 'active');
  assert.equal(listing.collectBy.toISOString(), deadline.toISOString(), 'Local input converted to the same instant');
  assert.equal(listing.foodStorage, null, 'Unstated storage stays unknown');

  phase = 'detail: collect-by and countdown for a neighbour';
  const np = await pageFor(neighbour);
  await np.goto(web + '/listings/' + listing.id);
  const food = np.getByRole('region', { name: 'Food rescue details' });
  await food.waitFor();
  assert.match(await food.innerText(), /Collect by[\s\S]*\d{1,2}:\d{2}[\s\S]*2 h \d+ min left/);
  assert.match(await food.innerText(), /Storage\s*Unknown — ask the giver/);
  assert.match(await food.innerText(), /Contains egg and peanuts/);
  await np.getByRole('heading', { name: 'Request this item' }).waitFor();
  await shot(np, 'detail-open');

  phase = 'API: discovery, pickup clamp and explicit-deadline rejection';
  const search = () => neighbour.api(`/listings?lat=${HOME.lat}&lng=${HOME.lng}&radiusKm=3&query=${encodeURIComponent('nasi boxes')}`);
  assert((await search()).body.items.some(i => i.id === listing.id));
  const req = await neighbour.api('/requests', 'POST', { listingId: listing.id, quantity: 1, message: '' }); assert.equal(req.status, 201);
  const late = await giver.api(`/requests/${req.body.id}/transition`, 'POST', { to: 'approved', pickupBy: new Date(deadline.getTime() + 3_600_000).toISOString() });
  assert.equal(late.status, 400, 'Explicit pickup after collect-by is rejected');
  const ok = await giver.api(`/requests/${req.body.id}/transition`, 'POST', { to: 'approved' });
  assert.equal(ok.status, 200); assert.equal(ok.body.pickupBy, deadline.toISOString(), 'Default pickup shortened to collect-by');
  const second = await (await person('late')).api('/requests', 'POST', { listingId: listing.id, quantity: 1, message: '' }); assert.equal(second.status, 201);

  phase = 'deadline passes: server rejects, UI closes, maintenance releases once';
  await db.$executeRaw`UPDATE listings SET collect_by = now() - interval '1 minute' WHERE id = ${listing.id}::uuid`;
  assert.equal((await (await person('after')).api('/requests', 'POST', { listingId: listing.id, quantity: 1, message: '' })).status, 409);
  assert.equal((await giver.api(`/requests/${req.body.id}/transition`, 'POST', { to: 'collected' })).status, 409);
  assert(!(await search()).body.items.some(i => i.id === listing.id), 'Expired food excluded from search');
  await np.reload(); await np.getByText('This food offer has passed its collect-by time').waitFor();
  assert.equal(await np.getByRole('heading', { name: 'Request this item' }).count(), 0);
  await shot(np, 'detail-expired');
  const maintenance = new MaintenanceService(db, null);
  await Promise.all([maintenance.expireFoodOffers(), maintenance.expireFoodOffers()]);
  const after = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(after.stockReserved, 0); assert(after.foodExpiredAt);
  assert.deepEqual((await db.donationRequest.findMany({ where: { listingId: listing.id } })).map(r => r.status).sort(), ['expired', 'expired']);
  await np.goto(web + '/notifications'); await np.getByText('Food collect-by time passed').first().waitFor();
  await shot(np, 'notifications');
  assert.equal(np.errors.length + gp.errors.length, 0, [...np.errors, ...gp.errors].join('\n'));
  console.log('food rescue form/detail/deadline checks passed');

  if (!skipAi) {
    phase = 'Ask: real Meta model drafts a food offer';
    const session = (await giver.api('/ask/sessions', 'POST', { clientId: randomUUID() })).body;
    const photo = await giver.api(`/ask/sessions/${session.id}/attachments`, 'POST', await fs.readFile('apps/api/seed-assets/products/nasi-goreng.jpg'), { 'Content-Type': 'image/jpeg' });
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    const send = async (text, attachmentIds = []) => { const r = await giver.api(`/ask/sessions/${session.id}/messages`, 'POST', { clientMessageId: randomUUID(), text, attachmentIds }); assert(r.status < 300, JSON.stringify(r.body)); const detail = (await giver.api(`/ask/sessions/${session.id}`)).body; return detail.messages.items.filter(m => m.role === 'assistant').at(-1); };
    let reply = await send('I have surplus food to give away: 4 boxes of nasi goreng that I cooked at noon today. Title: Nasi goreng boxes. Condition new. It needs to be collected within 3 hours. Storage and allergens: I am not sure.', [photo.body.id]);
    const answers = [[/collect/i, 'Within 3 hours'], [/how many/i, '4 boxes'], [/condition/i, 'New'], [/anything else|description/i, 'No extra description'], [/allerg|storage|prepar/i, 'I don\'t know'], [/title|call/i, 'Nasi goreng boxes']];
    for (let turn = 0; turn < 6; turn++) {
      const action = reply.parts.find(p => p.kind === 'action');
      if (action) break;
      const question = reply.parts.find(p => p.kind === 'questions')?.questions[0]?.question ?? reply.text;
      const answer = answers.find(([re]) => re.test(question))?.[1] ?? 'Please publish it now using my saved Profile location.';
      console.log(`  model asked: ${question.slice(0, 100)} → ${answer}`);
      reply = await send(answer);
      if (!reply.parts.some(p => p.kind === 'questions' || p.kind === 'action') && turn > 0) reply = await send('Please publish it now using my saved Profile location.');
    }
    const draft = (await db.askDraft.findFirstOrThrow({ where: { sessionId: session.id, kind: 'listing' } })).data;
    console.log('  stored draft', JSON.stringify({ foodRescue: draft.foodRescue, collectBy: draft.collectBy, quantity: draft.quantity, storage: draft.foodStorage, allergens: draft.foodAllergens }));
    assert.equal(draft.foodRescue, true, 'Model marked the draft as food rescue');
    assert(draft.collectBy && Math.abs(Date.parse(draft.collectBy) - Date.now() - 3 * 3_600_000) < 20 * 60_000, 'Deadline about three hours ahead');
    assert.equal(draft.foodAllergens, null, 'Allergens stay unknown'); assert.equal(draft.foodStorage, null, 'Storage stays unknown');
    const card = reply.parts.find(p => p.kind === 'action')?.action;
    assert(card, 'Publication review card prepared'); assert.equal(card.payload.action.body.food.collectBy, draft.collectBy);
    assert.equal(await db.listing.count({ where: { ownerId: giver.dbId, title: { contains: 'Nasi goreng', mode: 'insensitive' } } }), 0, 'Nothing published before Confirm');
    await gp.goto(web + '/needs?chat=' + session.id);
    await gp.getByText('Food rescue offer').last().waitFor({ timeout: 30_000 });
    await shot(gp, 'ask-review-card');
    await gp.getByRole('button', { name: 'Confirm', exact: true }).last().click();
    await gp.getByText('Listing published', { exact: false }).last().waitFor({ timeout: 60_000 });
    const published = await db.listing.findFirstOrThrow({ where: { ownerId: giver.dbId, foodRescue: true, id: { not: listing.id } } });
    assert.equal(published.status, 'active'); assert.equal(published.collectBy.toISOString(), new Date(draft.collectBy).toISOString()); assert.equal(published.foodAllergens, null);
    console.log('Ask food drafting via real Meta model passed');
  }
  console.log('smoke:food-rescue passed; screenshots in', out);
} catch (error) {
  console.error(`smoke:food-rescue failed during ${phase}`); throw error;
} finally {
  await browser?.close();
  const ids = (await db.user.findMany({ where: { firebaseUid: { in: Object.values(people).map(p => p.uid) } }, select: { id: true } })).map(u => u.id);
  const listingIds = (await db.listing.findMany({ where: { ownerId: { in: ids } }, select: { id: true } })).map(l => l.id);
  await db.donationRequest.deleteMany({ where: { listingId: { in: listingIds } } });
  await db.listing.deleteMany({ where: { id: { in: listingIds } } });
  await db.askSession.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.idempotencyKey.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await Promise.all(Object.values(people).map(p => auth.deleteUser(p.uid).catch(() => undefined)));
  await db.$disconnect(); await deleteApp(app);
}
