import { modelSafe, type AskMessage, type AskPart } from '@neighbourhood/shared';
type SearchPart = Extract<AskPart, {kind:'listings'}>;
const isSearch = (part: AskPart): part is SearchPart & {search: NonNullable<SearchPart['search']>} => part.kind === 'listings' && part.search !== undefined;

/** Apply to streamed text, stored history and final replies, never to user input. */
export function cleanAssistantText(text: string) {
  const label = text.search(/\b(?:server cards|application state|internal card context)\s*:/i);
  if (label >= 0) text = text.slice(0, label);
  const raw = /(?:```(?:json)?\s*)?(?:\[|\{)\s*(?:\{|"(?:kind|action|operation|attachmentIds|requiresConfirmation|functionCall)"\s*:)/i.exec(text);
  if (raw && /"(?:attachmentIds|requiresConfirmation|functionCall)"\s*:|"kind"\s*:\s*"(?:marketplace_confirmation|marketplace|listing_draft|action|questions|listings)"|"operation"\s*:/.test(text.slice(raw.index))) text = text.slice(0, raw.index);
  return text.trim();
}

/** Compact facts are supplied as application data, not as the model's own prose. */
export function cardContext(parts: AskPart[]) {
  const listing = (item: Extract<AskPart, {kind:'listings'}>['items'][number]) => ({ id: item.id, title: item.title, mode: item.mode, ownerId: item.ownerId, ownerDisplayName: item.ownerDisplayName, area: item.location.areaLabel, distanceKm: item.location.distanceKm });
  return modelSafe(parts.map(part => {
    if (part.kind === 'listings') return { kind: part.kind, items: part.items.map(listing), ...(part.search ? { search: { ...part.search, fartherItems: part.search.fartherItems.map(listing) } } : {}) };
    if (part.kind === 'listing_draft') return { kind: part.kind, draft: { id: part.draft.id, data: part.draft.data } };
    if (part.kind === 'action') return { kind: part.kind, action: modelSafe(part.action) };
    return part;
  }));
}

const numbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const indonesian = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh'];
export function quantityWasStated(messages: Array<{role:string;text:string}>, quantity: number) {
  const count = `(?:${quantity}|${numbers[quantity] ?? quantity}|${indonesian[quantity] ?? quantity})`;
  const explicit = new RegExp(`\\b(?:quantity|jumlah|sebanyak)\\s*[:=]?\\s*${count}\\b|\\b${count}\\b(?:\\s+[\\p{L}-]+){0,3}\\s+(?:items?|jackets?|shirts?|books?|pieces?|pairs?|clothes|tools?|chairs?|bags?|barang|baju|jaket|buku|unit|buah|potong)\\b`, 'iu');
  const offering = new RegExp(`\\b(?:donate|donating|share|sharing|lend|lending|give away|giving away|i have|i've got|donasi|donasikan|bagikan|pinjamkan|punya|ada)\\s+(?:(?:my|these|those)\\s+)?${count}\\b`, 'iu');
  return messages.some((message, index) => message.role === 'user' && (explicit.test(message.text) || offering.test(message.text) ||
    /how many|what quantity|berapa|jumlah/i.test(messages[index - 1]?.text ?? '') && new RegExp(`^\\s*${count}(?:\\s|[.!]|$)`, 'iu').test(message.text)));
}

export const DESCRIPTION_QUESTION = 'Is there anything else a neighbour should know about it?';
export const NO_DESCRIPTION_OPTION = 'No extra description';
const declines = /^\s*(?:no|nope|none|nothing|n\/?a|skip|tidak|tidak ada|gak ada|ga ada|nggak ada|enggak)\b|\bno (?:extra |more |additional |other )?(?:description|details?|info(?:rmation)?)\b|\bnothing (?:else|more|to add)\b|\bthat'?s (?:all|it)\b|\bleave it (?:blank|empty)\b|\btanpa (?:deskripsi|keterangan)\b|\btidak ada (?:lagi|tambahan)\b/i;
const publishes = /\b(?:post|publish|list)\s+(?:it|this|them|the (?:item|listing|draft))\b|\b(?:post|publish)\b[^.?!]*\bnow\b|\bgo ahead\b|\bterbitkan\b|\bposting(?:kan)?\b|\bunggah\b/i;
export const wantsToPublish = (text: string) => publishes.test(text);

/**
 * True when the resident answered the server's description question by declining
 * or asking to publish. Only answers after the latest description question count.
 */
export function descriptionDeclined(messages: Array<{role:string;text:string}>) {
  const asked = messages.findLastIndex(message => message.role === 'assistant' && message.text.trim() === DESCRIPTION_QUESTION);
  if (asked < 0) return false;
  return messages.slice(asked + 1).some(message => message.role === 'user' && (declines.test(message.text) || publishes.test(message.text)));
}

export function clarifyAffirmation(messages: AskMessage[], text: string): AskPart | null {
  if (!/^(?:yes+|yess+|yeah|yep|sure|ok(?:ay)?|ya|iya|boleh)(?:\s+(?:please|thanks|do it|silakan|dong))?[.!\s]*$/i.test(text)) return null;
  const previous = messages.filter(message => message.role === 'assistant').at(-1);
  if (!previous || !/\bor\b|\batau\b/i.test(previous.text)) return null;
  const searches = previous.parts.filter(isSearch);
  if (new Set(searches.map(part => part.search?.mode)).size < 2) return null;
  return {kind:'questions', questions:[{question:'Did you mean the free items, or are you still looking to borrow?', options:['Show the free items', 'Keep looking to borrow']}]};
}

/** A search-only reply uses the actual scopes, so an empty 50 km check cannot promise more nearby results. */
export function searchReply(parts: AskPart[]) {
  const searches = parts.filter(isSearch);
  if (!searches.length || parts.some(part => part.kind !== 'listings')) return null;
  const first = searches[0]!; const scope = first.search!;
  const topic = scope.query ?? scope.category?.replaceAll('_', ' ');
  const label = `${scope.mode === 'donate' ? 'free ' : ''}${topic ? `${topic} ` : ''}${scope.mode === 'lend' ? 'items to borrow' : scope.mode === 'donate' ? 'items' : 'matching items'}`;
  if (first.items.length) return `I found ${label} within ${scope.radiusKm} km. Choose an item below to see its details.`;
  const none = `No eligible ${label} were found within ${scope.broaderRadiusKm && !scope.fartherItems.length ? scope.broaderRadiusKm : scope.radiusKm} km at this time.`;
  const alternative = searches.find(part => part !== first && part.items.length && part.search?.mode !== scope.mode);
  if (alternative) return `${none} There are ${alternative.search?.mode === 'donate' ? 'free items' : 'items to borrow'} within ${alternative.search!.radiusKm} km as an alternative. Would you like to look at those instead?`;
  if (scope.fartherItems.length) return `${none} Matching items were found farther away, outside ${scope.radiusKm} km. Their distances are shown below.`;
  return `${none} You can save this need or try a different item.`;
}

export const FOOD_DEADLINE_QUESTION = 'By when does the food need to be collected?';
const userText = (messages: Array<{role:string;text:string}>) => messages.filter(message => message.role === 'user').map(message => message.text.toLowerCase()).join('\n');
/** True when some meaningful word of the value appears in what the resident typed. */
function mentioned(text: string, value: string) {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word => word.length >= 3 && text.includes(word));
}
/**
 * Food safety facts must come from the resident, never from a photo or a guess.
 * Values the model supplies without a matching statement in the conversation are dropped to unknown.
 */
export function guardFoodFacts(args: { collectBy?: string | null; foodPreparedAt?: string | null; foodStorage?: string | null; foodAllergens?: string | null }, messages: Array<{role:string;text:string}>) {
  const text = userText(messages);
  if (args.foodAllergens && !mentioned(text, args.foodAllergens)) args.foodAllergens = null;
  if (args.foodStorage && !mentioned(text, args.foodStorage)) args.foodStorage = null;
  if (args.foodPreparedAt && !/\b(?:cook|cooked|prepar\w*|made|baked|fried|masak|dimasak|dibuat|digoreng|dipanggang)\b/i.test(text)) args.foodPreparedAt = null;
  if (args.collectBy && !/\d|hour|minute|tonight|noon|today|evening|morning|jam|menit|malam|siang|sore|pagi|hari ini/i.test(text)) args.collectBy = null;
}
