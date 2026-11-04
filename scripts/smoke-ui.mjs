import assert from 'node:assert/strict';
/* global document, window, innerWidth */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { stubMapTiles } from './map-test-tiles.mjs';

// Read-only visual/navigation checks against the local seeded demo. No AI model calls or marketplace writes.
const web = process.env.SMOKE_WEB_URL ?? 'http://localhost:5173';
assert(['localhost', '127.0.0.1'].includes(new URL(web).hostname));
const out = path.resolve(process.env.UI_SCREENSHOT_DIR ?? 'artifacts/ui');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge' });
const errors = []; const captures = [];
let phase = 'setup';
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
await stubMapTiles(context);
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
page.setDefaultTimeout(15000);
async function navigate(route) { await page.goto(web + route); await page.locator('main h1,main h2').first().waitFor(); await page.waitForLoadState('networkidle'); assert.equal(await page.getByRole('status', { name: 'Loading', exact: true }).count(), 0, `${route}: capture still loading`); }
async function noOverflow() { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${phase}: horizontal overflow`); }
async function shot(name) { await noOverflow(); await page.evaluate(() => window.scrollTo(0, 0)); const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: true }); captures.push({ name, file, viewport: page.viewportSize(), url: new URL(page.url()).pathname + new URL(page.url()).search }); }
try {
  await page.goto(web + '/login');
  await page.getByRole('button', { name: 'volunteer', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
  phase = 'donate entry';
  await page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  await page.getByLabel('Item Title *', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/share');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  phase = 'Share draft recovery and origin';
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Shared items', exact: true }).click();
  await page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  await page.getByLabel('Item Title *', { exact: true }).fill('Synthetic retained draft');
  await page.getByLabel('Description', { exact: true }).fill('Unsaved facts must survive a Profile round trip.');
  await page.getByLabel('Private Pickup Instructions *', { exact: true }).fill('Synthetic private draft note');
  const draftPhoto = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#0f766e' } }).png().toBuffer();
  await page.getByLabel('Item Photo', { exact: true }).setInputFiles({ name: 'synthetic-draft.png', mimeType: 'image/png', buffer: draftPhoto });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Profile', exact: true }).click();
  await page.goBack();
  assert.equal(await page.getByLabel('Item Title *', { exact: true }).inputValue(), 'Synthetic retained draft');
  assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Unsaved facts must survive a Profile round trip.');
  assert.equal(await page.getByLabel('Private Pickup Instructions *', { exact: true }).inputValue(), 'Synthetic private draft note');
  await page.getByRole('img', { name: 'Preview', exact: true }).waitFor();
  await shot('share-restored-mobile');
  await page.setViewportSize({ width: 1440, height: 900 }); await shot('share-restored-desktop'); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/activity?tab=giving', 'Cancel lost launch origin');
  await page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  assert.equal(await page.getByLabel('Item Title *', { exact: true }).inputValue(), 'Synthetic retained draft');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('link', { name: 'Donate / Share', exact: true }).click();
  assert.equal(await page.getByLabel('Item Title *', { exact: true }).inputValue(), '', 'Discard kept facts');
  assert.equal(await page.getByRole('img', { name: 'Preview', exact: true }).count(), 0, 'Discard kept photo');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Borrow', exact: true }).click();
  await page.getByRole('link', { name: 'View all', exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'lend');
  phase = 'Ask draft and keyboard layout';
  await navigate('/needs');
  const composer = page.getByLabel('Message NeighbourHood', { exact: true });
  await composer.fill('Unsaved navigation test draft');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Start', exact: true }).click();
  assert.equal(await composer.inputValue(), 'Unsaved navigation test draft');
  await composer.fill('');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  assert(await page.getByRole('dialog', { name: 'Chat history' }).isVisible());
  await page.keyboard.press('Escape');
  assert(!await page.getByRole('dialog', { name: 'Chat history' }).isVisible());
  await page.setViewportSize({ width: 390, height: 520 });
  await composer.focus();
  const inputBox = await composer.boundingBox(), navBox = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  assert(inputBox && navBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= navBox.y, 'Composer hidden under navigation');
  await shot('ask-short-viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  phase = 'loading placeholder';
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/listings?**', async route => { await gate; await route.continue(); });
  await page.goto(web + '/');
  await page.getByRole('status', { name: 'Loading', exact: true }).waitFor();
  await shot('home-loading'); release();
  await page.getByRole('status', { name: 'Loading', exact: true }).waitFor({ state: 'hidden' });
  await page.unroute('**/api/v1/listings?**');
  phase = 'empty search';
  await navigate('/explore?query=ui-no-match-7852e4653');
  await page.getByRole('heading', { name: 'No items match yet' }).waitFor();
  await shot('explore-empty');
  phase = 'page captures';
  await navigate('/explore');
  const listingLink = await page.locator('a[href^="/listings/"]').first().getAttribute('href');
  await navigate('/communities');
  const communityLink = page.getByRole('button', { name: /Demo sharing circle/ });
  await communityLink.click();
  await page.getByRole('button', { name: 'View inventory / deposit', exact: true }).first().click();
  const communityRoute = new URL(page.url()).pathname + new URL(page.url()).search;
  const routes = [['home','/'],['explore','/explore'],['ask','/needs'],['activity','/activity'],['loans','/activity?tab=loans'],['shared','/activity?tab=giving'],['messages','/messages'],['updates','/notifications'],['saved-needs','/needs/saved'],['communities',communityRoute],['profile','/profile'],['categories','/categories'],['share','/share'],['item',listingLink]];
  for(const [size, width, height] of [['mobile',390,844],['desktop',1440,900]]) {
    await page.setViewportSize({ width, height });
    for(const [name,route] of routes) { phase = name + '-' + size; await navigate(route); await shot(phase); }
  }
  for(const width of [320,440,533]) {
    await page.setViewportSize({ width, height: 956 });
    for(const [name,route] of [['home','/'],['ask','/needs']]) { phase = `${name}-user-${width}`; await navigate(route); await shot(phase); }
  }
  const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const login = await anonymous.newPage(); await login.goto(web + '/login'); await login.getByRole('heading', { name: 'Sign in', exact: true }).waitFor(); const loginFile = path.join(out,'login-mobile.png'); await login.screenshot({ path: loginFile, fullPage: true }); captures.push({name:'login-mobile',file:loginFile,viewport:{width:390,height:844},url:'/login'}); await anonymous.close();
  phase = 'sign-out draft isolation';
  await navigate('/share'); await page.getByLabel('Item Title *', { exact: true }).fill('Private draft before sign-out');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Start', exact: true }).click();
  await composer.fill('Draft that must be cleared on sign-out');
  await navigate('/profile'); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'owner', exact: true }).click(); await page.waitForURL(url => url.pathname === '/');
  await navigate('/needs'); assert.equal(await composer.inputValue(), '', 'Draft crossed account boundary');
  await navigate('/share'); assert.equal(await page.getByLabel('Item Title *', { exact: true }).inputValue(), '', 'Share draft crossed account boundary');
  assert.equal(errors.length, 0, 'Browser runtime errors');
  await fs.writeFile(path.join(out,'captures.json'), JSON.stringify({capturedAt:new Date().toISOString(), source:'Live local demo API + Edge, synthetic seeded demo data, no marketplace writes', captures, checks:['Donate / Share direct form','Share facts/private note/photo restored after Profile round trip','Cancel returns to Activity origin','Discard clears facts and photo','Home mode carried to Explore','Account-scoped in-memory draft preserved across navigation','History dialog and Escape','Composer visible in 390x520 viewport','Real pending request skeleton','Real empty search','Sign-out clears Ask and Share drafts','No horizontal overflow or page errors']}, null, 2));
  // A contact sheet of each viewport makes capture validity inspectable in a bounded batch.
  for(let i=0;i<captures.length;i+=4) {
    const group = captures.slice(i,i+4); const panels = [];
    for(let j=0;j<group.length;j++) { const image = await sharp(group[j].file).resize({width:390,height:1100,fit:'contain',background:'#e7e5e4'}).png().toBuffer(); panels.push({input:image,left:j*390,top:40}); }
    const labels = `<svg width="1560" height="40"><rect width="100%" height="100%" fill="white"/>${group.map((g,j)=>`<text x="${j*390+10}" y="26" font-family="sans-serif" font-size="16">${g.name}</text>`).join('')}</svg>`;
    await sharp({create:{width:1560,height:1140,channels:3,background:'#e7e5e4'}}).composite([{input:Buffer.from(labels),left:0,top:0},...panels]).png().toFile(path.join(out,`sheet-${i/4+1}.png`));
  }
  console.log(`PASS UI navigation, draft, modal, skeleton, empty state and short-viewport checks; ${captures.length} captures across mobile, desktop, 320, 440 and 533 px`);
} catch(error) { console.error(`FAIL ${phase}: ${String(error.message).split('\n').slice(0,3).join(' ')}`); await page.screenshot({path:path.join(out,'capture-failure.png'),fullPage:true}).catch(()=>undefined); process.exitCode=1; }
finally { await browser.close(); }
