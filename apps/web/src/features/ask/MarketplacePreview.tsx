import type { MarketplaceAction } from '@neighbourhood/shared';
import type { ReactNode } from 'react';
import { ListingPublicationPreview, ReviewFields } from './ListingPublicationPreview';

export function MarketplacePreview({ action, photos }: { action: MarketplaceAction; photos?: ReactNode }) {
  if (action.operation === 'listing_publish') return <ListingPublicationPreview action={action} photos={photos} />;
  const fields: Array<[string, string | number | null | undefined]> = [];
  switch (action.operation) {
    case 'listing_edit': fields.push(...Object.entries(action.body).filter(([,v]) => typeof v === 'string' || typeof v === 'number').map(([k,v]) => [k.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()), v as string | number] as [string, string | number])); break;
    case 'listing_transition': fields.push(['New status', action.body.to]); break;
    case 'loan_request': fields.push(['From', action.body.startDate], ['Return by', action.body.endDate], ['Message', action.body.message]); break;
    case 'loan_transition': fields.push(['New status', action.body.to], ['Return condition', action.body.returnConditionNote]); break;
    case 'deposit_propose': for (const item of action.body.items) fields.push([item.title, item.quantity], ['Best before', item.bestBefore]); break;
    case 'deposit_review': fields.push(['Decision', action.body.to], ['Accepted quantities', action.body.acceptedQuantities?.join(', ')], ['Review note', action.body.reviewNote]); break;
    case 'stock_adjust': fields.push(['Quantity change', action.body.delta], ['Reason', action.body.reason], ['Note', action.body.note]); break;
    case 'member_update': fields.push(['Role', action.role], ['Status', action.status]); break;
    case 'profile_preferences': fields.push(['Language', action.preferredLanguage], ['Search radius in km', action.searchRadiusKm], ['Public neighbourhood / city', action.areaLabel]); break;
    case 'community_create': fields.push(['Community', action.body.name], ['Area', action.body.areaLabel], ['Joining', action.body.joinPolicy]); break;
    case 'point_create': fields.push(['Point', action.body.name], ['Partner', action.body.partnerName], ['Address', action.body.exactAddress], ['Public address consent', action.body.publicAddressConsent ? 'Yes' : 'No']); break;
  }
  if (action.operation === 'listing_edit') {
    const appliance = action.body.appliance;
    if (appliance) fields.push(['Working status', appliance.workingStatus], ['Brand', appliance.brand], ['Model', appliance.model], ['Weight (kg)', appliance.approxWeightKg], ['Dimensions (cm)', appliance.dimensionsCm ? `${appliance.dimensionsCm.width} × ${appliance.dimensionsCm.height} × ${appliance.dimensionsCm.depth}` : 'Not confirmed'], ['Power', appliance.powerRequirement], ['Pickup floor', appliance.access.floorLevel ?? 'Not confirmed'], ['Elevator', appliance.access.elevatorAvailable == null ? 'Not confirmed' : appliance.access.elevatorAvailable ? 'Yes' : 'No'], ['Dismantling', appliance.access.requiresDismantling == null ? 'Not confirmed' : appliance.access.requiresDismantling ? 'Required' : 'Not required'], ['Installation', appliance.access.requiresInstallation == null ? 'Not confirmed' : appliance.access.requiresInstallation ? 'Required' : 'Not required'], ['Helpers', appliance.access.suggestedHelpers ?? 'Not confirmed'], ['Access notes', appliance.access.notes]);
    const food = action.body.food;
    if (food) fields.push(['Collect by', food.collectBy ? new Date(food.collectBy).toLocaleString() : undefined], ['Prepared', food.preparedAt === null ? 'Unknown' : food.preparedAt ? new Date(food.preparedAt).toLocaleString() : undefined], ['Storage', food.storage === null ? 'Unknown' : food.storage], ['Allergens', food.allergens === null ? 'Unknown' : food.allergens]);
    if (action.body.lending) fields.push(['Loan notes', action.body.lending.notes], ['Deposit required', action.body.lending.depositRequired ? 'Yes' : 'No']);
  }
  if (action.operation === 'point_create') fields.push(['Public area', action.body.areaLabel], ['Point latitude', action.body.location.lat], ['Point longitude', action.body.location.lng]);
  return <ReviewFields fields={fields} />;
}
