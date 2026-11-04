import type { ReactNode } from 'react';
import type { MarketplaceAction } from '@neighbourhood/shared';
import { countdownText, formatLocalDateTime } from '../listings/FoodRescue';

type Field = [string, string | number | null | undefined];
const labels: Record<string, string> = { donate: 'Free to keep', lend: 'Borrow & return', new: 'New', good: 'Good', fair: 'Fair', like_new: 'Like new', needs_repair: 'Needs repair', checked_out: 'On loan', pending: 'Awaiting approval', rejected: 'Declined', partially_working: 'Partially working', not_working: 'Not working', unknown: 'Not confirmed', mobility_aids: 'Mobility aids', owner_location: 'Collect from the owner', community_point: 'Community collection point', approval_required: 'Approval required', deposit_accepted: 'Deposit accepted' };
export function reviewValue(value: string | number) {
  return typeof value === 'number' ? value : labels[value] ?? value;
}
export function ReviewFields({ fields }: { fields: Field[] }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">{fields.filter(([,v]) => v !== undefined && v !== null && v !== '').map(([label, value], index) => <div key={index} className={['Message', 'Note', 'Private pickup instructions', 'Access notes', 'Review note', 'Address', 'Loan notes'].includes(label) ? 'col-span-2' : ''}><dt className="text-stone-600">{label}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words font-medium">{reviewValue(value!)}</dd></div>)}</dl>;
}
export function ListingPublicationPreview({ action, photos }: { action: Extract<MarketplaceAction, { operation: 'listing_publish' }>; photos?: ReactNode }) {
  const { body } = action, appliance = body.appliance;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start gap-3">{photos}<div className="min-w-0 flex-1 basis-32"><h4 className="break-words text-base font-semibold">{body.title}</h4><p className="mt-1 text-sm capitalize text-stone-600">{reviewValue(body.category)}</p></div></div>
    <ReviewFields fields={[["Offering", body.mode], ['Condition', body.condition], ['Quantity', body.quantity], ['Pickup area', body.areaLabel], ['Maximum loan days', body.lending?.maxLoanDays], ['Best before', body.bestBefore]]} />
    {body.food && <div className="space-y-2 rounded-xl border border-orange-200 bg-orange-50/60 p-3"><p className="text-sm font-semibold">Food rescue offer</p><ReviewFields fields={[['Collect by', `${formatLocalDateTime(body.food.collectBy)} (${countdownText(body.food.collectBy)})`], ['Prepared', body.food.preparedAt ? formatLocalDateTime(body.food.preparedAt) : 'Unknown'], ['Storage', body.food.storage ?? 'Unknown'], ['Allergens', body.food.allergens ?? 'Unknown']]} /><p className="text-xs text-stone-600">Check these times and details yourself. Unknown details stay unknown to neighbours.</p></div>}
    {body.description && (body.description.length > 160 ? <details><summary className="cursor-pointer py-2 text-sm font-semibold text-brand-800">Read item description</summary><p className="whitespace-pre-wrap break-words text-sm">{body.description}</p></details> : <p className="whitespace-pre-wrap break-words text-sm text-stone-700">{body.description}</p>)}
    <details className="border-t border-stone-200 pt-1"><summary className="cursor-pointer py-3 text-sm font-semibold text-brand-800">Pickup & listing details</summary><div className="space-y-4 pb-2"><ReviewFields fields={[["Collection", body.collection.method], ['Private pickup instructions', body.pickupInstructions], ['Photos', action.attachmentIds.length], ['Loan notes', body.lending?.notes], ['Deposit required', body.lending ? body.lending.depositRequired ? 'Yes' : 'No' : undefined]]} />
      {appliance && <ReviewFields fields={[["Working status", appliance.workingStatus], ['Brand', appliance.brand], ['Model', appliance.model], ['Weight (kg)', appliance.approxWeightKg], ['Dimensions (cm)', appliance.dimensionsCm ? `${appliance.dimensionsCm.width} × ${appliance.dimensionsCm.height} × ${appliance.dimensionsCm.depth}` : 'Not confirmed'], ['Power', appliance.powerRequirement], ['Pickup floor', appliance.access.floorLevel ?? 'Not confirmed'], ['Elevator', appliance.access.elevatorAvailable == null ? 'Not confirmed' : appliance.access.elevatorAvailable ? 'Yes' : 'No'], ['Dismantling', appliance.access.requiresDismantling == null ? 'Not confirmed' : appliance.access.requiresDismantling ? 'Required' : 'Not required'], ['Installation', appliance.access.requiresInstallation == null ? 'Not confirmed' : appliance.access.requiresInstallation ? 'Required' : 'Not required'], ['Helpers', appliance.access.suggestedHelpers ?? 'Not confirmed'], ['Access notes', appliance.access.notes]]} />}
      <p className="text-sm text-stone-600">Exact pickup details are shared with approved participants only.</p>
    </div></details>
  </div>;
}
