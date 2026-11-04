import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ListingPublicSchema, type AskMessage, type AskPart } from '@neighbourhood/shared';
import { cardContext, cleanAssistantText, clarifyAffirmation, descriptionDeclined, DESCRIPTION_QUESTION, quantityWasStated, searchReply, wantsToPublish } from './ask.presentation.js';

const item = ListingPublicSchema.parse({ id: randomUUID(), ownerId: randomUUID(), ownerDisplayName: 'Neighbour', title: 'Cotton jackets', category: 'clothing', mode: 'donate', status: 'active', condition: 'good', description: 'Cotton jackets', stock: { total: 3, reserved: 0, collected: 0 }, photos: [{path:'listings/item/photo.webp',url:'/signed-photo'}], location: {areaLabel:'Jakarta',approxLat:-6.19,approxLng:106.82,distanceKm:2}, collection: {method:'owner_location',communityPointId:null}, appliance:null,lending:null,bestBefore:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() });
const empty: AskPart = { kind:'listings', items:[], search:{radiusKm:3,broaderRadiusKm:50,fartherItems:[],mode:'lend',category:'clothing'} };
const free: AskPart = { kind:'listings', items:[item], search:{radiusKm:3,broaderRadiusKm:null,fartherItems:[],mode:'donate',category:'clothing'} };
const message = (text:string, parts:AskPart[]=[]): AskMessage => ({id:randomUUID(),sequence:1,role:'assistant',text,parts,attachments:[],createdAt:new Date().toISOString()});

describe('grounded Ask presentation', () => {
  it('removes echoed internal cards from saved and partial replies without changing natural prose', () => {
    expect(cleanAssistantText('Review the card below.\nServer cards: [{"attachmentIds":["private"]}]')).toBe('Review the card below.');
    expect(cleanAssistantText('Review it.\n```json\n{"kind":"marketplace_confirmation","action":{"operation":"listing_publish"}}')).toBe('Review it.');
    expect(cleanAssistantText('You can share a jacket.')).toBe('You can share a jacket.');
  });
  it('provides compact real references without signed photo data', () => {
    const context=JSON.stringify(cardContext([free])); expect(context).toContain(item.id); expect(context).not.toContain('/signed-photo'); expect(context).not.toContain('storagePath');
  });
  it('requires quantity from the user, not a photo or the assistant draft', () => {
    expect(quantityWasStated([{role:'user',text:"Here's my clothes"},{role:'assistant',text:'Two jackets.'},{role:'user',text:'Like new'}],2)).toBe(false);
    expect(quantityWasStated([{role:'assistant',text:'How many are you sharing?'},{role:'user',text:'2'}],2)).toBe(true);
    expect(quantityWasStated([{role:'user',text:'Give away two good jackets.'}],2)).toBe(true);
    expect(quantityWasStated([{role:'user',text:'Saya mau donasi dua baju.'}],2)).toBe(true);
    expect(quantityWasStated([{role:'user',text:'quantity: 1'}],1)).toBe(true);
    expect(quantityWasStated([{role:'user',text:'I want to donate one rice cooker.'}],1)).toBe(true);
    expect(quantityWasStated([{role:'user',text:'Lend for two days.'}],2)).toBe(false);
  });
  it('clarifies yes to conflicting branches and preserves an explicit choice', () => {
    const history=[message('Request the free items, or widen the borrowing search?', [empty,free])];
    expect(clarifyAffirmation(history,'yess please')).toMatchObject({kind:'questions'});
    expect(clarifyAffirmation(history,'Show the free items')).toBeNull();
    expect(clarifyAffirmation([message('Would you like one of the free items?', [free])],'yes please')).toBeNull();
  });
  it('states the actual wider empty scope and separates real free alternatives', () => {
    expect(searchReply([empty])).toContain('clothing items to borrow were found within 50 km');
    expect(searchReply([empty])).not.toMatch(/widen|how far/i);
    expect(searchReply([empty,free])).toContain('free items within 3 km as an alternative');
    expect(searchReply([empty,{kind:'questions',questions:[{question:'Which one?',options:[]}]}])).toBeNull();
  });
  it('counts an explicit decline or publish request as answering the description question', () => {
    const asked = [{ role: 'user', text: 'I want to donate a rice cooker' }, { role: 'assistant', text: DESCRIPTION_QUESTION }];
    for (const answer of ['No extra description.', 'No extra description', 'nothing else', 'none', 'okay just post it now.', 'tidak ada tambahan'])
      expect(descriptionDeclined([...asked, { role: 'user', text: answer }])).toBe(true);
    expect(descriptionDeclined([...asked, { role: 'user', text: 'It has a small scratch on the lid' }])).toBe(false);
    expect(descriptionDeclined([{ role: 'user', text: 'no' }, { role: 'assistant', text: DESCRIPTION_QUESTION }])).toBe(false);
    expect(descriptionDeclined([{ role: 'assistant', text: 'Would you like to give this away?' }, { role: 'user', text: 'No' }])).toBe(false);
    expect(wantsToPublish('okay just post it now.')).toBe(true);
    expect(wantsToPublish('Please publish this')).toBe(true);
    expect(wantsToPublish('What does publishing involve?')).toBe(false);
    expect(quantityWasStated([{ role: 'user', text: 'I have 1 rice cooker' }], 1)).toBe(true);
  });
});
