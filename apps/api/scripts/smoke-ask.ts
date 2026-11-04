import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { z } from 'zod';
import { AskActionSchema, AskAttachmentSchema, AskRunSchema, AskSessionDetailSchema, AskSessionSchema, AskStatusSchema, ListingDraftSchema, SavedNeedPageSchema } from '@neighbourhood/shared';
import { createDb } from '../src/lib/db.js';

// Explicitly local: this script creates and removes only its own disposable user.
const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const base = new URL(process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8080');
const database = new URL(process.env.DATABASE_URL ?? '');
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '';
const projectId = process.env.FIREBASE_PROJECT_ID ?? '';
assert(local(base.hostname) && local(database.hostname), 'Smoke test requires local API and database');
assert(process.env.USE_FIREBASE_EMULATORS === 'true' && projectId.startsWith('demo-'), 'Smoke test requires demo Firebase emulators');
assert(local(new URL(`http://${authHost}`).hostname), 'Auth emulator must be local');
assert(local(new URL(`http://${storageHost}`).hostname), 'Storage emulator must be local');
assert(process.env.FIREBASE_STORAGE_BUCKET, 'Set the demo Storage bucket');

const app = initializeApp({ projectId, storageBucket: process.env.FIREBASE_STORAGE_BUCKET }, `ask-smoke-${randomUUID()}`);
const auth = getAuth(app);
const db = createDb(process.env.DATABASE_URL!);
const uid = `ask-smoke-${randomUUID()}`;
let created = false;
let token = '';
let phase = 'setup';
const report = (message: string) => process.stdout.write(`${message}\n`);
async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(`/api/v1${path}`, base), {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  assert(response.ok, `${phase}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function send(sessionId: string, text: string, attachmentIds: string[] = []) {
  const run = AskRunSchema.parse(await api(`/ask/sessions/${sessionId}/messages`, 'POST', { clientMessageId: randomUUID(), text, attachmentIds }));
  assert.equal(run.status, 'completed', `${phase}: ${run.errorCode ?? run.status}`);
  return AskSessionDetailSchema.parse(await api(`/ask/sessions/${sessionId}`));
}
try {
  await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true, displayName: 'Ask smoke fixture' });
  created = true;
  const customToken = await auth.createCustomToken(uid);
  const login = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert(login.ok, `Emulator sign-in: HTTP ${login.status}`);
  token = z.object({ idToken: z.string() }).parse(await login.json()).idToken;
  const status = AskStatusSchema.parse(await api('/ask/status'));
  assert(status.available && status.imagesAvailable, 'Configure META_API_KEY and Storage before this test');
  const session = AskSessionSchema.parse(await api('/ask/sessions', 'POST', { clientId: randomUUID() }));
  phase = 'live product guide';
  let detail = await send(session.id, 'In English, briefly explain what a community collection point is in NeighbourHood. Use the product guide and clarify whether it is a reward score.');
  let answer = detail.messages.items.filter(m => m.role === 'assistant').at(-1)?.text ?? '';
  assert(/physical|pantry|sharing box|drop.off|donat/i.test(answer), 'Expected physical collection-point explanation');
  assert(/not|isn.t|no reward/i.test(answer), 'Expected distinction from reward points');
  const fixture = await db.user.findUniqueOrThrow({ where: { firebaseUid: uid } });
  await db.userRole.create({ data: { userId: fixture.id, role: 'product_category_editor' } });
  phase = 'live caller account knowledge';
  detail = await send(session.id, 'Read my current account. What platform role do I actually have and have I joined any communities? Do not infer memberships from the neighbour label. Reply in English.');
  answer = detail.messages.items.filter(m => m.role === 'assistant').at(-1)?.text ?? '';
  assert(/category.{0,20}editor/i.test(answer), 'Expected actual fixture platform role');
  assert(/no communit|not.{0,30}join|haven.t.{0,20}join|any communit|zero communit/i.test(answer), 'Expected no inferred community membership');
  assert.equal(await db.askAction.count({ where: { sessionId: session.id } }), 0, 'Product/account help must not propose marketplace writes');
  report('PASS real Meta model product knowledge and actual caller roles without inferred memberships');
  phase = 'live saved-needs tool';
  detail = await send(session.id, 'Tampilkan kebutuhan tersimpan saya. Gunakan list_saved_needs.');
  assert(detail.messages.items.some(m => m.parts.some(p => p.kind === 'saved_needs' && p.items.length === 0)));
  assert(detail.messages.items.some(m => m.role === 'assistant' && /kebutuhan|tersimpan|belum/i.test(m.text)), 'Expected Indonesian reply');
  report('PASS real Meta model tool call and persisted history');

  phase = 'live saved-need proposal';
  detail = await send(session.id, 'Prepare a saved need for two donated books, category books, donation preference, no dates or attributes. Use prepare_save_need and show the review card.');
  const part = detail.messages.items.flatMap(m => m.parts).find(p => p.kind === 'action');
  assert(part?.kind === 'action' && part.action.payload.kind === 'save_need', 'Expected saved-need review card');
  assert.equal(SavedNeedPageSchema.parse(await api('/needs')).items.length, 0, 'Proposal must not write before confirmation');
  const extraction = structuredClone(part.action.payload.extraction);
  extraction.items[0]!.name = 'Children books smoke fixture';
  const edited = AskActionSchema.parse(await api(`/ask/actions/${part.action.id}`, 'PATCH', { revision: part.action.revision, extraction }));
  const completed = AskActionSchema.parse(await api(`/ask/actions/${edited.id}/confirm`, 'POST', { revision: edited.revision }));
  assert.equal(completed.status, 'completed');
  await api(`/ask/actions/${edited.id}/confirm`, 'POST', { revision: edited.revision });
  assert.equal(SavedNeedPageSchema.parse(await api('/needs')).items.length, 1, 'Confirmation retry must not duplicate needs');
  report('PASS edit, explicit confirmation, and idempotent saved need');

  phase = 'photo upload';
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const headers = { 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID() };
  const photo = AskAttachmentSchema.parse(await api(`/ask/sessions/${session.id}/attachments`, 'POST', bytes, headers));
  const repeat = AskAttachmentSchema.parse(await api(`/ask/sessions/${session.id}/attachments`, 'POST', bytes, headers));
  assert.equal(photo.id, repeat.id);
  assert.equal(photo.mimeType, 'image/webp');
  const photoUrl = new URL(`/api/v1/ask/sessions/${session.id}/attachments/${photo.id}`, base);
  assert.equal((await fetch(photoUrl)).status, 401);
  const loaded = await fetch(photoUrl, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(loaded.status, 200);
  assert.equal((await sharp(Buffer.from(await loaded.arrayBuffer())).metadata()).format, 'webp');
  report('PASS private Storage upload, normalization, read, and retry');
  phase = 'live image understanding';
  detail = await send(session.id, 'Describe the color of this test image in English, briefly. Do not create a draft or action.', [photo.id]);
  assert(detail.messages.items.some(m => m.role === 'assistant' && /\bred\b/i.test(m.text)), 'Expected red image description');
  report('PASS real Meta model image understanding');

  phase = 'owned-photo structured listing assistance';
  const suggested = z.object({ requiresUserReview: z.literal(true), draft: ListingDraftSchema }).parse(await api('/ai/listing-draft', 'POST', { sessionId: session.id, attachmentId: photo.id, hint: 'A synthetic red picture card offered for donation. Unknown condition and quantity.' }));
  assert(suggested.requiresUserReview && suggested.draft);
  report('PASS real owned-photo listing suggestions requiring review');

  phase = 'session isolation and deletion';
  const separate = AskSessionSchema.parse(await api('/ask/sessions', 'POST', { clientId: randomUUID() }));
  assert.equal(AskSessionDetailSchema.parse(await api(`/ask/sessions/${separate.id}`)).messages.items.length, 0);
  await api(`/ask/sessions/${session.id}`, 'DELETE');
  assert.equal(SavedNeedPageSchema.parse(await api('/needs')).items.length, 1, 'Deleting chat must preserve saved needs');
  assert.equal((await fetch(photoUrl, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  report('PASS separate sessions and chat deletion preserving saved needs');
} catch (error) {
  // Avoid printing provider responses, tokens or environment values.
  console.error(`FAIL ${phase}: ${error instanceof assert.AssertionError ? error.message : 'operation failed'}`);
  process.exitCode = 1;
} finally {
  try {
    const user = await db.user.findUnique({ where: { firebaseUid: uid } });
    if (user) {
      const attachments = await db.askAttachment.findMany({ where: { session: { userId: user.id } } });
      for (const attachment of attachments) await getStorage(app).bucket().file(attachment.storagePath).delete({ ignoreNotFound: true });
      await db.user.delete({ where: { id: user.id } });
    }
    if (created) await auth.deleteUser(uid);
    report('Removed disposable smoke-test records');
  } catch {
    console.error(`Fixture cleanup failed; remove only firebase UID ${uid}`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
    await deleteApp(app);
  }
}
