import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { AskSessionSchema, AskSessionDetailSchema, AskRunSchema } from '@neighbourhood/shared';
import { createDb } from '../src/lib/db.js';

const base=process.env.SMOKE_API_URL??'http://localhost:8080';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname) && process.env.USE_FIREBASE_EMULATORS==='true');
const app=initializeApp({projectId:process.env.FIREBASE_PROJECT_ID});const auth=getAuth(app);const db=createDb(process.env.DATABASE_URL!);const uid='search-smoke-'+randomUUID();let token='';let phase='setup';
async function api(route:string,body?:unknown){const response=await fetch(base+'/api/v1'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});assert(response.ok,`HTTP ${response.status}`);return response.json();}
try{
 await auth.createUser({uid,email:uid+'@example.test',emailVerified:true});const custom=await auth.createCustomToken(uid);
 const signed=await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=local-test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true})});token=(await signed.json() as {idToken:string}).idToken;
 await api('/me');const anchor=await db.user.findUniqueOrThrow({where:{firebaseUid:'demo-owner'}});await db.user.update({where:{firebaseUid:uid},data:{homeLat:anchor.homeLat,homeLng:anchor.homeLng,searchRadiusKm:3}});
 const session=AskSessionSchema.parse(await api('/ask/sessions',{clientId:randomUUID()}));
 async function send(text:string){const run=AskRunSchema.parse(await api(`/ask/sessions/${session.id}/messages`,{clientMessageId:randomUUID(),text,attachmentIds:[]}));assert.equal(run.status,'completed',run.errorCode??run.status);const detail=AskSessionDetailSchema.parse(await api('/ask/sessions/'+session.id));return detail.messages.items.filter(m=>m.role==='assistant').at(-1)!;}
 phase='farther matches';let message=await send('Find a sewing machine within 3 km. Tell me honestly whether any matching listings are farther away, in English.');let card=message.parts.find(p=>p.kind==='listings');assert(card?.kind==='listings'&&card.search?.radiusKm===3&&card.items.length===0&&card.search.fartherItems.length>0);assert(/3|50|farther|further|outside/i.test(message.text));
 phase='manual radius follow-up';message=await send('Use 20 km for the same sewing machine search.');card=message.parts.find(p=>p.kind==='listings');assert(card?.kind==='listings'&&card.search?.radiusKm===20&&card.items.length>0);
 phase='absent item scope';message=await send('Find a quantum-laser-harp within 7 km. Do not substitute another product.');card=message.parts.find(p=>p.kind==='listings');assert(card?.kind==='listings'&&card.search?.radiusKm===7&&card.items.length===0&&card.search.broaderRadiusKm===50&&card.search.fartherItems.length===0);assert(/7|50/.test(message.text),'Reply must state its checked distance');
 process.stdout.write('PASS real Meta model: farther matches, manual 20 km follow-up and absent item with explicit checked scope\n');
}catch(error){console.error(`FAIL ${phase}: ${error instanceof assert.AssertionError?error.message:'operation failed'}`);process.exitCode=1;}
finally{await db.user.deleteMany({where:{firebaseUid:uid}});await auth.deleteUser(uid).catch(()=>undefined);await db.$disconnect();await deleteApp(app);}
