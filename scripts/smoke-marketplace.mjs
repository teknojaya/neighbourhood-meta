import { publishPhotoFixture } from './photo-fixtures.mjs';
import assert from 'node:assert/strict';
import { stubMapTiles } from './map-test-tiles.mjs';
/* global document, innerWidth, window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createDb } from '../apps/api/src/lib/db.ts';

const base = new URL(process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8080');
const web = new URL(process.env.SMOKE_WEB_URL ?? 'http://localhost:5173');
const local = host => ['localhost','127.0.0.1','[::1]'].includes(host);
assert(local(base.hostname) && local(web.hostname) && local(new URL(process.env.DATABASE_URL).hostname));
assert(process.env.USE_FIREBASE_EMULATORS === 'true' && process.env.FIREBASE_PROJECT_ID?.startsWith('demo-'));
assert(local(new URL('http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST).hostname));
assert(local(new URL('http://' + process.env.FIREBASE_STORAGE_EMULATOR_HOST).hostname));
const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID, storageBucket: process.env.FIREBASE_STORAGE_BUCKET }, 'market-smoke-' + randomUUID());
const auth = getAuth(app), storage = getStorage(app), db = createDb(process.env.DATABASE_URL);
const fixtures = [], communityIds = []; let browser; let phase = 'setup';
const report = value => process.stdout.write(value + '\n');
async function api(who, route, method = 'GET', body, key = randomUUID()) {
  const headers = { Authorization: 'Bearer ' + who.token, 'Idempotency-Key': key };
  if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'image/png' : 'application/json';
  const response = await fetch(new URL('/api/v1' + route, base), { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `${phase}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function user(name) {
  const uid = 'market-smoke-' + randomUUID();
  await auth.createUser({ uid, displayName: name, email: uid + '@example.test', emailVerified: true });
  const fixture = { uid }; fixtures.push(fixture);
  fixture.custom = await auth.createCustomToken(uid);
  const result = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: fixture.custom, returnSecureToken: true }) });
  assert(result.ok); fixture.token = (await result.json()).idToken;
  const me = await api(fixture, '/me'); fixture.id = me.userId;
  await api(fixture, '/me/profile', 'PUT', { displayName: name, preferredLanguage: 'en', areaLabel: 'Smoke neighbourhood', homeLocation: { lat: -6.2, lng: 106.816 }, searchRadiusKm: 3 });
  return fixture;
}
async function mobile(who) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await stubMapTiles(context);
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.name));
  // Route the test browser to its dedicated API, leaving any user's dev server alone.
  await page.route('**/api/v1/**', async route => { try { const source = new URL(route.request().url()); const response = await route.fetch({ url: new URL(source.pathname + source.search, base).href }); await route.fulfill({ response }); } catch { await route.abort().catch(() => undefined); } });
  await page.goto(new URL('/login', web).href);
  await page.evaluate(async custom => { const { getFirebaseAuth } = await import('/src/lib/firebase.ts'); const { signInWithCustomToken } = await import('/node_modules/.vite/deps/firebase_auth.js'); await signInWithCustomToken(getFirebaseAuth(), custom); }, who.custom);
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
  return { context, page, errors };
}
async function layout(page) { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow'); }
try {
  const owner = await user('Smoke Owner'), neighbour = await user('Smoke Neighbour');
  phase = 'browser launch';
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  phase = 'mobile sign-in';
  const donor = await mobile(owner), recipient = await mobile(neighbour);
  phase = 'mobile publication';
  await donor.page.goto(web.href);
  await donor.page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  await donor.page.waitForURL(url => url.pathname === '/share');
  const title = 'Smoke picture books ' + randomUUID().slice(0, 6);
  const photo = await sharp({ create: { width: 96, height: 96, channels: 3, background: 'red' } }).png().toBuffer();
  await donor.page.getByLabel('Title', { exact: false }).fill(title);
  await donor.page.getByPlaceholder('Tell neighbours more').fill('Synthetic test books for the complete donation flow.');
  await donor.page.getByLabel('Item photo (required)', { exact: true }).setInputFiles({ name: 'synthetic-red-test.png', mimeType: 'image/png', buffer: photo });
  await donor.page.getByRole('button', { name: 'Publish Listing', exact: true }).click();
  await donor.page.getByRole('link', { name: new RegExp(title) }).first().waitFor();
  const listing = (await api(owner, '/listings/mine')).items.find(item => item.title === title); assert(listing);
  assert.equal(listing.photos.length, 1, 'Publication did not retain the selected photo');
  const listingPhoto = await fetch(new URL(listing.photos[0].url, base));
  assert.equal(listingPhoto.status, 200);
  assert.equal((await sharp(Buffer.from(await listingPhoto.arrayBuffer())).metadata()).format, 'webp');
  await donor.page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  assert.equal(await donor.page.getByLabel('Title', { exact: false }).inputValue(), '', 'Successful publication retained a stale draft');
  await donor.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(new URL(donor.page.url()).searchParams.get('tab'), 'giving', 'Share cancel lost Activity origin');
  phase = 'real Ask search';
  await recipient.page.goto(new URL('/needs', web).href);
  await recipient.page.getByLabel('Message NeighbourHood', { exact: true }).waitFor();
  assert.equal((await api(neighbour, '/ask/sessions')).items.length, 0, 'Opening Ask must not create a session');
  await recipient.page.getByRole('button', { name: 'New chat', exact: true }).click();
  await recipient.page.getByRole('button', { name: 'Find an item', exact: true }).click();
  assert.equal((await api(neighbour, '/ask/sessions')).items.length, 0, 'Starters must not create empty sessions');
  await recipient.page.getByLabel('Message NeighbourHood', { exact: true }).fill(`Find nearby items with the exact search keyword "${title.split(' ').at(-1)}". Use search_listings.`);
  const firstReply = recipient.page.waitForResponse(r => /\/ask\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 90000 });
  await recipient.page.getByRole('button', { name: 'Send', exact: true }).click();
  await recipient.page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 90000 });
  await recipient.page.waitForURL(url => url.searchParams.has('chat'));
  const session = { id: new URL(recipient.page.url()).searchParams.get('chat') };
  assert((await firstReply).ok(), 'Streaming message request failed');
  await recipient.page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 90000 });
  const detail = await api(neighbour, `/ask/sessions/${session.id}`);
  assert.equal(detail.latestRun?.status, 'completed', detail.latestRun?.errorCode ?? 'run failed');
  assert(detail.messages.items.some(m => m.parts.some(p => p.kind === 'listings' && p.items.some(item => item.id === listing.id))));
  report('PASS immediate Ask composer, no empty session creation, first-send session and real Meta model discovery');

  phase = 'real extraction and saved-need matching';
  const extracted = await api(neighbour, '/ai/needs/extract', 'POST', { text: 'I need one donated picture book for a child.' });
  assert(extracted.requiresUserReview && extracted.extraction.items.length);
  const saved = await api(neighbour, '/needs', 'POST', { extraction: extracted.extraction });
  const matches = await api(neighbour, `/needs/${saved.id}/matches`);
  assert.equal(matches.explanationSource, 'model'); assert(matches.items.every(item => item.listing.id && !('exactLocation' in item.listing)));
  report('PASS real structured needs extraction and grounded Meta model match explanations');

  phase = 'real typed marketplace action';
  const ownerSession = await api(owner, '/ask/sessions', 'POST', { clientId: randomUUID() });
  const pauseRun = await api(owner, `/ask/sessions/${ownerSession.id}/messages`, 'POST', { clientMessageId: randomUUID(), text: `Read my listing ${listing.id}, then use prepare_marketplace_action to prepare listing_transition to paused. Do not execute it.`, attachmentIds: [] });
  assert.equal(pauseRun.status, 'completed', pauseRun.errorCode ?? 'run failed');
  const ownerDetail = await api(owner, `/ask/sessions/${ownerSession.id}`);
  const pauseAction = ownerDetail.messages.items.flatMap(m => m.parts).find(p => p.kind === 'action' && p.action.payload.kind === 'marketplace');
  assert.equal(pauseAction?.action.payload.action.operation, 'listing_transition');
  assert.equal((await api(owner, '/listings/' + listing.id)).listing.status, 'active');
  await api(owner, '/ask/actions/' + pauseAction.action.id + '/cancel', 'POST');
  report('PASS real typed marketplace proposal without an unconfirmed write');

  phase = 'photo to reviewed Ask publication';
  await donor.page.goto(new URL('/needs', web).href);
  const uploaded = donor.page.waitForResponse(r => /\/ask\/sessions\/[^/]+\/attachments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await donor.page.getByLabel('Add photo', { exact: true }).setInputFiles({ name: 'synthetic-red-test.png', mimeType: 'image/png', buffer: photo });
  await donor.page.waitForURL(url => url.searchParams.has('chat'));
  const photoSession = { id: new URL(donor.page.url()).searchParams.get('chat') };
  const attachment = await (await uploaded).json();
  const draftTitle = 'Smoke red picture ' + randomUUID().slice(0, 6);
  const draftRun = await api(owner, `/ask/sessions/${photoSession.id}/messages`, 'POST', { clientMessageId: randomUUID(), text: `Use draft_listing to prepare title "${draftTitle}", category books, mode donate, condition good, quantity 1, description "Synthetic red picture for a donation test". The attached image is a test photo.`, attachmentIds: [attachment.id] });
  assert.equal(draftRun.status, 'completed', draftRun.errorCode ?? 'draft failed');
  await donor.page.goto(new URL('/needs?chat=' + photoSession.id, web).href);
  await donor.page.getByRole('button', { name: 'Review and prepare publication' }).click();
  await donor.page.getByLabel('Title', { exact: false }).fill(draftTitle);
  await donor.page.getByRole('button', { name: 'Prepare review card', exact: true }).click();
  await donor.page.getByRole('button', { name: 'Confirm', exact: true }).last().waitFor();
  assert(!(await api(owner, '/listings/mine')).items.some(item => item.title === draftTitle), 'Review must not publish');
  await donor.page.getByRole('button', { name: 'Confirm', exact: true }).last().click();
  await donor.page.getByText('Listing published', { exact: false }).last().waitFor();
  const published = (await api(owner, '/listings/mine')).items.filter(item => item.title === draftTitle);
  assert.equal(published.length, 1); assert.equal(published[0].photos.length, 1);
  const photoDetail = await api(owner, `/ask/sessions/${photoSession.id}`);
  const publication = photoDetail.messages.items.flatMap(m => m.parts).find(p => p.kind === 'action' && p.action.payload.kind === 'marketplace' && p.action.payload.action.operation === 'listing_publish');
  await api(owner, `/ask/actions/${publication.action.id}/confirm`, 'POST', { revision: publication.action.revision });
  assert.equal((await api(owner, '/listings/mine')).items.filter(item => item.title === draftTitle).length, 1);
  const photoRead = await fetch(new URL(published[0].photos[0].url, base));
  assert.equal(photoRead.status, 200); assert.equal((await sharp(Buffer.from(await photoRead.arrayBuffer())).metadata()).format, 'webp');
  report('PASS real Ask photo draft, mobile review, explicit publication, bucket photo and idempotent confirmation');

  phase = 'mobile find and request';
  await recipient.page.goto(new URL('/explore', web).href);
  await recipient.page.getByLabel('Find an item').fill(title.split(' ').at(-1)); await recipient.page.getByRole('button', { name: 'Search', exact: true }).click();
  await recipient.page.getByRole('link', { name: new RegExp(title) }).click();
  await recipient.page.getByRole('button', { name: /Request this item/i }).click();
  await recipient.page.waitForURL(url => url.pathname === '/activity' && url.searchParams.has('request'));
  const requestId = new URL(recipient.page.url()).searchParams.get('request');
  phase = 'mobile owner approval';
  await donor.page.goto(new URL('/activity?request=' + requestId, web).href);
  await donor.page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await donor.page.getByRole('button', { name: 'Confirm', exact: true }).first().click();
  await donor.page.getByText('Ready to collect', { exact: true }).first().waitFor();
  phase = 'pickup, message and collection';
  await recipient.page.goto(new URL('/listings/' + listing.id, web).href); await recipient.page.getByText('Already approved? View pickup details', { exact: true }).click();
  await recipient.page.getByText('Ring front door or message on arrival', { exact: true }).waitFor();
  const req = await api(neighbour, '/requests/' + requestId);
  await api(neighbour, `/conversations/${req.conversationId}/messages`, 'POST', { body: 'I can collect today at five.' });
  await donor.page.goto(new URL('/activity?request=' + requestId, web).href);
  await donor.page.getByRole('button', { name: 'Confirm pickup', exact: true }).first().click(); await donor.page.getByRole('button', { name: 'Confirm', exact: true }).first().click();
  await donor.page.getByText('Collected', { exact: true }).first().waitFor();
  assert.equal((await api(owner, '/listings/' + listing.id)).listing.stock.collected, 1);

  phase = 'mobile borrowing lifecycle';
  const lend = await api(owner, '/listings', 'POST', { mode: 'lend', category: 'household', title: 'Smoke lending tools', description: 'Disposable tools for the borrowing test', condition: 'good', quantity: 1, areaLabel: 'Smoke neighbourhood', exactLocation: { lat: -6.2, lng: 106.816 }, pickupInstructions: 'Message on arrival', collection: { method: 'owner_location', communityPointId: null }, lending: { maxLoanDays: 7, depositRequired: false, notes: null } });
  await publishPhotoFixture(base,owner,lend,'tool-kit');
  await recipient.page.goto(new URL('/listings/' + lend.id, web).href);
  const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await recipient.page.getByLabel('Borrow from').fill(day(0)); await recipient.page.getByLabel('Return by').fill(day(2));
  await recipient.page.getByRole('button', { name: 'Reviewed — request these dates' }).click();
  await recipient.page.waitForURL(url => url.pathname === '/activity' && url.searchParams.has('loan'));
  const loanId = new URL(recipient.page.url()).searchParams.get('loan');
  for (const status of ['approved', 'checked_out', 'returned']) {
    await donor.page.goto(new URL('/activity?loan=' + loanId, web).href);
    await donor.page.getByRole('button', { name: ({approved:'Approve loan',checked_out:'Confirm collection',returned:'Confirm return'})[status], exact: true }).click();
    if (status === 'returned') await donor.page.getByLabel('Returned condition').fill('Returned clean and working');
    await donor.page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await donor.page.locator('p').filter({ hasText: new RegExp('^' + status.replaceAll('_', ' ') + '$') }).first().waitFor();
    assert.equal((await api(neighbour, '/loans/' + loanId)).status, status);
  }
  report('PASS mobile loan dates, approval, checkout and return');

  phase = 'mobile community deposit and linked stock';
  await db.userRole.create({ data: { userId: owner.id, role: 'staff' } });
  const community = await api(owner, '/communities', 'POST', { name: 'Smoke sharing community', areaLabel: 'Smoke neighbourhood', description: 'Disposable smoke community', joinPolicy: 'open' }); communityIds.push(community.id);
  const pointSession = await api(owner, '/ask/sessions', 'POST', { clientId: randomUUID() });
  const pointRun = await api(owner, `/ask/sessions/${pointSession.id}/messages`, 'POST', { clientMessageId: randomUUID(), text: `Use get_community for ${community.id} and show its card so I can add a collection point with the secure form.`, attachmentIds: [] });
  assert.equal(pointRun.status, 'completed');
  await donor.page.goto(new URL('/needs?chat=' + pointSession.id, web).href);
  await donor.page.getByRole('button', { name: 'Review a new collection point' }).click();
  await donor.page.getByLabel('Name', { exact: true }).fill('Smoke partner pantry');
  await donor.page.getByLabel('Area', { exact: true }).fill('Smoke neighbourhood');
  await donor.page.getByLabel('Partner name', { exact: true }).fill('Smoke partner');
  await donor.page.getByLabel('Exact point address', { exact: true }).fill('Synthetic private point address');
  await donor.page.getByLabel('Point latitude', { exact: true }).fill('-6.2');
  await donor.page.getByLabel('Point longitude', { exact: true }).fill('106.816');
  await donor.page.getByLabel('I have the partner’s consent to operate this point').check();
  await donor.page.getByRole('button', { name: 'Prepare point review card' }).click();
  await donor.page.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  assert.equal((await api(owner, `/communities/${community.id}/points`)).items.length, 0);
  await donor.page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await donor.page.getByText('Collection point created', { exact: false }).waitFor();
  const point = (await api(owner, `/communities/${community.id}/points`)).items[0]; assert(point);
  await recipient.page.goto(new URL('/communities?point=' + point.id, web).href);
  await recipient.page.getByRole('button', { name: 'Confirm join request' }).click();
  await recipient.page.getByText('Membership: active · member', { exact: true }).waitFor();
  await recipient.page.getByText('Donate items at this point', { exact: true }).click();
  await recipient.page.getByLabel('Item', { exact: true }).fill('Smoke point books');
  await recipient.page.getByLabel('Quantity', { exact: true }).fill('2');
  await recipient.page.getByRole('button', { name: 'Confirm proposed deposit' }).click();
  await recipient.page.getByText('Deposit proposed. Arrange your drop-off with the point.', { exact: true }).waitFor();
  await donor.page.goto(new URL('/communities?point=' + point.id, web).href);
  await donor.page.getByLabel('Smoke point books: accepted of 2').fill('2');
  await donor.page.getByLabel('I received and checked the accepted items in person').check();
  await donor.page.getByRole('button', { name: 'Accept reviewed counts' }).click();
  await donor.page.getByRole('button', { name: 'Review and share confirmed stock' }).waitFor();
  await donor.page.getByRole('button', { name: 'Review and share confirmed stock' }).click();
  await donor.page.getByLabel('Item photo (required)', {exact:true}).setInputFiles('apps/api/seed-assets/products/pantry-staples.jpg');
  await donor.page.getByRole('button', { name: 'Publish Listing', exact: true }).click();
  await donor.page.getByRole('link', { name: 'View / request this point item' }).waitFor();
  const inventory = (await api(owner, `/points/${point.id}/inventory`)).items[0]; assert.equal(inventory.available, 2); assert(inventory.listingId);
  const qr = await api(neighbour, '/points/by-qr/' + point.qrId); assert.equal(qr.id, point.id); assert.equal(qr.publicAddress, null);
  await layout(donor.page); await layout(recipient.page);
  report('PASS Ask secure point creation, mobile point deep link, membership, deposit, volunteer review, inventory-backed publication and private QR resolution');
  for (const account of [owner, neighbour]) { const inbox = await api(account, '/notifications'); assert(inbox.items.some(item => item.type === 'loan_update')); if (account === neighbour) assert(inbox.items.some(item => item.type === 'deposit_update')); }
  for (const route of ['/needs?chat=' + session.id, '/explore', '/activity', '/messages', '/notifications', '/communities', '/needs/saved']) { await recipient.page.goto(new URL(route, web).href); await recipient.page.locator('h1,h2').first().waitFor(); await layout(recipient.page); }
  assert.equal(donor.errors.length + recipient.errors.length, 0, 'Browser runtime error');
  const output = process.env.SMOKE_SCREENSHOT_DIR;
  if (output) { await fs.mkdir(output, { recursive: true }); await recipient.page.goto(new URL('/needs?chat=' + session.id, web).href); await recipient.page.getByRole('link', { name: new RegExp(title) }).first().waitFor(); await recipient.page.evaluate(() => window.scrollTo(0, 0)); await recipient.page.screenshot({ path: path.join(output, 'ask-mobile.png'), fullPage: true }); await donor.page.evaluate(() => window.scrollTo(0, 0)); await donor.page.screenshot({ path: path.join(output, 'activity-mobile.png'), fullPage: true }); }
  report('PASS real two-user mobile publish → search → request → approve → pickup/chat → collect; no overflow or runtime errors');
  await donor.context.close(); await recipient.context.close();
} catch (error) {
  console.error(`FAIL ${phase}: ${error instanceof assert.AssertionError ? error.message : error?.name ?? 'operation failed'}`); process.exitCode = 1;
  if (browser && process.env.SMOKE_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.SMOKE_SCREENSHOT_DIR, { recursive: true });
    let index = 0;
    for (const context of browser.contexts()) for (const page of context.pages()) { await page.screenshot({ path: path.join(process.env.SMOKE_SCREENSHOT_DIR, `failure-${index}.png`), fullPage: true }).catch(() => undefined); await fs.writeFile(path.join(process.env.SMOKE_SCREENSHOT_DIR, `failure-${index++}.txt`), (await page.locator('body').innerText().catch(() => '')).slice(0, 8000)); }
  }
}
finally {
  await browser?.close();
  const userIds = fixtures.map(f => f.id).filter(Boolean), firebaseUids = fixtures.map(f => f.uid);
  try {
    const listingRows = await db.listing.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const listingIds = listingRows.map(l => l.id);
    for (const photo of await db.listingPhoto.findMany({ where: { listingId: { in: listingIds } } })) await storage.bucket().file(photo.storagePath).delete({ ignoreNotFound: true });
    for (const photo of await db.askAttachment.findMany({ where: { session: { userId: { in: userIds } } } })) await storage.bucket().file(photo.storagePath).delete({ ignoreNotFound: true });
    await db.askSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.donationRequest.deleteMany({ where: { ownerId: { in: userIds } } }); await db.loan.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.listing.deleteMany({ where: { id: { in: listingIds } } }); await db.community.deleteMany({ where: { id: { in: communityIds } } }); await db.user.deleteMany({ where: { id: { in: userIds } } });
    for (const uid of firebaseUids) await auth.deleteUser(uid);
    report('Removed only disposable marketplace smoke fixtures');
  } catch { console.error('Smoke cleanup needs attention for fixture UIDs: ' + firebaseUids.join(', ')); process.exitCode = 1; }
  await db.$disconnect(); await deleteApp(app);
}
