import { SearchListingCard } from './SearchListingCard';
import { QuestionCard } from './QuestionCard';
import { PublishDraft } from './PublishDraft';
import { PointDraft } from './PointDraft';
import { MarketplacePreview } from './MarketplacePreview';
import { MatchList } from '../needs/NeedMatches';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiRoutes, AskActionSchema, ItemCategorySchema, type AskAction, type AskAttachment, type AskInput, type AskPart } from '@neighbourhood/shared';
import { ActionPill, Alert, Button, Card, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { api, privateImage, ApiError } from '../../lib/api';
import { featureError } from '../activity/feature-errors';
import { useOnline } from '../../lib/useOnline';

const marketplaceTitles = {
  saved_item_add: 'Save this item', saved_item_remove: 'Remove this saved item',
  listing_publish: 'Publish this item', listing_edit: 'Update this item',
  listing_transition: 'Change listing availability', photo_delete: 'Remove this photo',
  loan_request: 'Request a loan', loan_transition: 'Update this loan',
  community_join: 'Join this community', community_create: 'Create a community',
  point_create: 'Add a collection point', member_update: 'Update community membership',
  deposit_propose: 'Offer a deposit', deposit_review: 'Review this deposit',
  stock_adjust: 'Record an inventory change', need_delete: 'Remove this saved need',
  notification_read: 'Mark this notification as read', profile_preferences: 'Update your preferences',
};

export function PrivatePhoto({ sessionId, attachment, compact = false }: { sessionId: string; attachment: Pick<AskAttachment, 'id'>; compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null); setFailed(false);
    void privateImage(`${ApiRoutes.ask}/sessions/${sessionId}/attachments/${attachment.id}`, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sessionId, attachment.id, attempt]);
  return url ? <img src={url} alt={t('ask.photoAlt')} className={`${compact ? 'h-20 w-20' : 'h-28 w-28'} rounded-xl object-cover`} />
    : <span className={`${compact ? 'h-20 w-20' : 'h-28 w-28'} flex flex-col items-center justify-center gap-1 rounded-xl bg-stone-100 p-2 text-xs`}>{failed ? t('ask.photoUnavailable') : t('common.loading')}{failed && <button type="button" className="min-h-11 text-brand-800 underline" onClick={() => setAttempt(value => value + 1)}>Retry photo</button>}</span>;
}

export function AskCard({ part, sessionId, onEditDraft, onReply, onInput, disabled = false, active = true, radiusAnswered = false, imagesAvailable = true }: { part: AskPart; sessionId: string; onEditDraft(): void; onReply(text: string): void; onInput(input: AskInput): void; disabled?: boolean; active?: boolean; radiusAnswered?: boolean; imagesAvailable?: boolean }) {
  switch (part.kind) {
    case 'input_request': return active ? <div className="space-y-2"><ActionPill type="button" disabled={disabled || part.input === 'photo' && !imagesAvailable} onClick={() => onInput(part.input)}>{part.input === 'photo' ? 'Add a photo' : part.input === 'profile_location' ? 'Set Profile location' : 'Enter custom pickup details'}</ActionPill>{part.input === 'photo' && <p className="text-sm text-stone-600">A photo is required to publish an item.</p>}</div> : null;
    case 'questions': return <QuestionCard part={part} onReply={onReply} disabled={disabled} active={active} />;
    case 'matches': return <Card className="space-y-3"><h3 className="font-semibold">Matches for your saved need</h3>{part.items.length === 0 ? <p>No matches nearby yet.</p> : <MatchList items={part.items} explanationSource={part.explanationSource} />}</Card>;
    case 'listings': return <SearchListingCard part={part} onReply={onReply} active={active} radiusAnswered={radiusAnswered} />;
    case 'loans': return <Card>{part.items.length === 0 && <p>No loans yet.</p>}{part.items.map(item => <Link className="block py-3" key={item.id} to={'/activity?loan=' + item.id}>{item.listingTitle} · {item.status}<p className="text-sm">{item.startDate} → {item.endDate}{item.overdue ? ' · Overdue' : ''}</p></Link>)}</Card>;
    case 'communities': return <Card>{part.items.map(item => <div key={item.id}><Link className="block py-3" to={'/communities?community=' + item.id}><strong>{item.name}</strong><p>{item.areaLabel} · {item.memberCount} members</p></Link><PointDraft communityId={item.id} sessionId={sessionId} /></div>)}</Card>;
    case 'points': return <Card>{part.items.map(item => <Link className="block py-3" key={item.id} to={'/communities?point=' + item.id}><strong>{item.name}</strong><p>{item.publicAddress ?? item.location.areaLabel}</p></Link>)}</Card>;
    case 'inventory': return <Card>{part.items.map(item => <p className="py-2" key={item.id}>{item.title} · {item.available} available{item.bestBefore ? ' · best before ' + item.bestBefore : ''}</p>)}</Card>;
    case 'deposits': return <Card>{part.items.map(item => <p className="py-2" key={item.id}>{item.items.map(i => i.title + ' × ' + i.quantity).join(', ')} · {item.status}</p>)}</Card>;
    case 'members': return <Card>{part.items.map(item => <p className="break-words py-2" key={item.userId}>{item.displayName ?? 'Neighbour'} · {item.role} · {item.status}</p>)}</Card>;
    case 'stock_audit': return <Card>{part.items.map(item => <p className="py-2" key={item.id}>{item.delta} · {item.reason} · {item.note}</p>)}</Card>;
    case 'action': return <ActionCard key={`${part.action.id}:${part.action.revision}:${part.action.status}`} action={part.action} sessionId={sessionId} />;
    case 'listing_draft': return <Card className="space-y-2">
      <h3 className="font-semibold">{t('ask.listingDraft')}</h3>
      {part.draft.attachments.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Draft photos">{part.draft.attachments.map(attachment => <PrivatePhoto key={attachment.id} sessionId={sessionId} attachment={attachment} />)}</div>}
      <p>{part.draft.data.title ?? t('ask.unknown')}</p>
      <p className="text-sm text-stone-600">{part.draft.data.category ? t(`category.${part.draft.data.category}`) : t('ask.unknown')} · {part.draft.data.mode ?? t('ask.unknown')}</p>
      <p className="text-sm">{part.draft.data.description}</p>
      <p className="text-sm">{t('ask.draftFacts', { quantity: part.draft.data.quantity ?? t('ask.unknown'), condition: part.draft.data.condition?.replaceAll('_', ' ') ?? t('ask.unknown') })}</p>
      <PublishDraft draft={part.draft} sessionId={sessionId} />
      <Button type="button" variant="secondary" onClick={onEditDraft}>{t('ask.editInChat')}</Button>
    </Card>;
    case 'saved_needs': return <Card className="space-y-2"><h3 className="font-semibold">{t('needs.savedTitle')}</h3>
      {part.items.length === 0 && <p>{t('needs.savedEmpty')}</p>}
      {part.items.map((need) => <p key={need.id} className="text-sm">{need.extraction.items.map((item) => item.name).join(', ')}</p>)}
      <Link className="text-sm font-semibold text-brand-800 underline" to="/needs/saved">{t('ask.manageNeeds')}</Link>
    </Card>;
    case 'requests': return <Card className="space-y-2"><h3 className="font-semibold">{t('activity.title')}</h3>
      {part.items.length === 0 && <p>{t('ask.noResults')}</p>}
      {part.items.map((item) => <Link key={item.id} to={`/activity?request=${item.id}`} className="block border-b border-stone-100 py-2 text-sm"><strong>{item.listingTitle ?? t('activity.item')}</strong><br />{t(`request.status.${item.status}`)} · {t('needs.quantity', { value: item.quantity })}</Link>)}
    </Card>;
    case 'conversations': return <Card className="space-y-2"><h3 className="font-semibold">{t('module.messages.title')}</h3>
      {part.items.length === 0 && <p>{t('messages.empty')}</p>}
      {part.items.map((item) => <Link className="block py-2 text-sm text-brand-800 underline" key={item.id} to={`/messages?conversation=${item.id}`}>{item.listingTitle ?? t('module.messages.title')}</Link>)}
    </Card>;
    case 'messages': return <Card className="space-y-2"><h3 className="font-semibold">{t('module.messages.title')}</h3>
      {part.items.length === 0 && <p>{t('messages.noMessages')}</p>}
      {[...part.items].reverse().map((item) => <p key={item.id} className="whitespace-pre-wrap break-words border-b border-stone-100 py-2 text-sm">{item.body}</p>)}
    </Card>;
    case 'notifications': return <Card className="space-y-2"><h3 className="font-semibold">{t('module.notifications.title')}</h3>
      {part.items.length === 0 && <p>{t('notifications.empty')}</p>}
      {part.items.map((item) => <p className="text-sm" key={item.id}>{item.title}</p>)}
      <Link to="/notifications" className="text-sm text-brand-800 underline">{t('notifications.open')}</Link>
    </Card>;
  }
}

function ActionCard({ action, sessionId }: { action: AskAction; sessionId: string }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [edit, setEdit] = useState(false);
  const [handedOver, setHandedOver] = useState(false);
  const [extraction, setExtraction] = useState(action.payload.kind === 'save_need' ? action.payload.extraction : null);
  const mutation = useMutation({
    mutationFn: ({ operation }: { operation: 'confirm' | 'cancel' | 'edit' }) => api(`${ApiRoutes.ask}/actions/${action.id}${operation === 'edit' ? '' : `/${operation}`}`, {
      method: operation === 'edit' ? 'PATCH' : 'POST',
      body: operation === 'edit' ? { revision: action.revision, extraction } : operation === 'confirm' ? { revision: action.revision } : undefined,
      schema: AskActionSchema,
    }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ask-detail', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['saved-needs'] });
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['loans'] });
      void queryClient.invalidateQueries({ queryKey: ['my-listings'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-item-ids'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-items'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const isMarketplaceHandover = action.payload.kind === 'marketplace' && ((action.payload.action.operation === 'loan_transition' && ['checked_out', 'returned'].includes(action.payload.action.body.to)) || action.payload.action.operation === 'deposit_review' || action.payload.action.operation === 'stock_adjust');
  const isHandover = isMarketplaceHandover || action.payload.kind === 'transition_request' && action.payload.body.to === 'collected';
  const pending = action.status === 'pending';
  const market = action.payload.kind === 'marketplace' ? action.payload.action : null;
  const marketplaceReview = market && <MarketplacePreview action={market} photos={market.operation === 'listing_publish' ? <div className="flex flex-wrap gap-2" aria-label="Photos to publish">{market.attachmentIds.map(id => <PrivatePhoto compact key={id} sessionId={sessionId} attachment={{ id }} />)}</div> : undefined} />;
  return <Card className="space-y-3 border-brand-200 bg-brand-50">
    <h3 className="font-semibold">{action.payload.kind === 'marketplace' ? marketplaceTitles[action.payload.action.operation] : t(`ask.action.${action.payload.kind}`)}</h3>
    {market?.operation !== 'listing_publish' && <p className="break-words text-sm">{action.summary}</p>}
    {marketplaceReview && (pending || action.status === 'executing' ? marketplaceReview : <details><summary className="cursor-pointer py-2 text-sm font-semibold text-brand-800">View action details</summary><div className="pt-2">{marketplaceReview}</div></details>)}
    {action.payload.kind === 'send_message' && <><blockquote className="whitespace-pre-wrap break-words rounded-xl bg-stone-50 p-3 text-sm">{action.payload.body}</blockquote><Link className="text-sm text-brand-800 underline" to={`/messages?conversation=${action.payload.conversationId}`}>{t('ask.openConversation')}</Link></>}
    {action.payload.kind === 'request_item' && <><p>{t('needs.quantity', { value: action.payload.body.quantity })}</p>{action.payload.body.message && <blockquote className="whitespace-pre-wrap break-words text-sm">{action.payload.body.message}</blockquote>}</>}
    {action.payload.kind === 'transition_request' && <div className="space-y-2 text-sm">
      {action.payload.body.to === 'approved' && <p>{action.payload.body.pickupBy ? t('activity.pickupBy', { date: new Date(action.payload.body.pickupBy).toLocaleString() }) : t('ask.defaultPickup')}</p>}
      {action.payload.body.note && <blockquote className="whitespace-pre-wrap break-words rounded-xl bg-stone-50 p-3">{action.payload.body.note}</blockquote>}
    </div>}
    {extraction && !edit && <div className="space-y-1 text-sm">
      {extraction.items.map((item, index) => <div key={index}><p>{item.name} · {item.category.replaceAll('_', ' ')} · {t(`needs.preference.${item.preference}`)}{item.quantity === null ? '' : ` · ${item.quantity}`}</p>{item.attributes.map((attribute, i) => <p key={i} className="text-stone-600">{attribute.name}: {attribute.value}</p>)}</div>)}
      {extraction.timing.neededBy && <p>{t('needs.neededBy', { date: extraction.timing.neededBy })}</p>}
      {extraction.timing.loanDurationDays && <p>{t('needs.duration', { days: extraction.timing.loanDurationDays })}</p>}
      {extraction.timing.originalText && <p>{extraction.timing.originalText}</p>}
      {extraction.clarificationQuestions.map((question, index) => <p key={`q-${index}`} className="text-stone-600">{question}</p>)}
      {extraction.outOfScope.map((item, index) => <p key={`o-${index}`} className="text-stone-600">{item.note}</p>)}
    </div>}
    {pending && edit && extraction && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); mutation.mutate({ operation: 'edit' }); }}>
      {extraction.items.map((item, index) => <div key={index} className="space-y-2 rounded-xl bg-stone-50 p-3">
        <TextField label={t('ask.itemName')} value={item.name} maxLength={200} required onChange={(event) => setExtraction({ ...extraction, items: extraction.items.map((old, i) => i === index ? { ...old, name: event.target.value } : old) })} />
        <label className="block space-y-1 text-sm">{t('needs.category')}<select className="block min-h-11 w-full rounded-xl border border-stone-300 bg-white p-2" value={item.category} onChange={(event) => setExtraction({ ...extraction, items: extraction.items.map((old, i) => i === index ? { ...old, category: event.target.value as typeof item.category } : old) })}>
          {[...ItemCategorySchema.options, 'other', 'unknown'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label className="block space-y-1 text-sm">{t('needs.preference')}<select className="block min-h-11 w-full rounded-xl border border-stone-300 bg-white p-2" value={item.preference} onChange={(event) => setExtraction({ ...extraction, items: extraction.items.map((old, i) => i === index ? { ...old, preference: event.target.value as typeof item.preference } : old) })}>
          {(['donation', 'borrow', 'either', 'unknown'] as const).map((value) => <option key={value} value={value}>{t(`needs.preference.${value}`)}</option>)}
        </select></label>
        <TextField type="number" label={t('activity.quantity')} min={1} max={1000} value={item.quantity ?? ''} onChange={(event) => setExtraction({ ...extraction, items: extraction.items.map((old, i) => i === index ? { ...old, quantity: event.target.value ? Number(event.target.value) : null } : old) })} />
      </div>)}
      <TextField type="date" label={t('ask.neededBy')} value={extraction.timing.neededBy ?? ''} onChange={(event) => setExtraction({ ...extraction, timing: { ...extraction.timing, neededBy: event.target.value || null } })} />
      <Button type="submit" disabled={mutation.isPending || !online}>{t('ask.updatePreview')}</Button>
    </form>}
    {mutation.isError && <Alert tone="error">{featureError(mutation.error)}</Alert>}
    {action.errorCode && !mutation.isError && <Alert tone="error">{featureError(new ApiError(action.errorCode, '', 0))}</Alert>}
    {action.receipt && <Alert tone={action.status === 'completed' ? 'success' : 'info'}>{action.receipt.message}{action.receipt.link && <Link className="ml-2 underline" to={action.receipt.link}>{t('notifications.open')}</Link>}</Alert>}
    {pending && <>
      <p className="text-xs text-stone-500">{t('ask.reviewHint')}</p>
      {isHandover && <label className="flex gap-2 text-sm"><input type="checkbox" checked={handedOver} onChange={(event) => setHandedOver(event.target.checked)} />{isMarketplaceHandover ? 'I checked this handover or inventory change in person.' : t('ask.handoverCheck')}</label>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={mutation.isPending || !online || edit || (isHandover && !handedOver)} onClick={() => mutation.mutate({ operation: 'confirm' })}>{t('common.confirm')}</Button>
        {extraction && <Button type="button" variant="secondary" disabled={mutation.isPending || !online} onClick={() => setEdit(!edit)}>{edit ? t('common.back') : t('ask.edit')}</Button>}
        <Button type="button" variant="ghost" disabled={mutation.isPending || !online} onClick={() => mutation.mutate({ operation: 'cancel' })}>{t('ask.cancel')}</Button>
      </div>
    </>}
    {action.status === 'executing' && <><Alert>{t('ask.actionRunning')}</Alert><Button type="button" variant="secondary" disabled={mutation.isPending || !online} onClick={() => mutation.mutate({ operation: 'confirm' })}>{t('ask.checkAction')}</Button></>}
    {!action.receipt && (action.status === 'cancelled' || action.status === 'expired') && <p className="text-sm text-stone-500">{t(`ask.actionState.${action.status}`)}</p>}
  </Card>;
}
