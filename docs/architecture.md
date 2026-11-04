# Architecture

The React PWA calls Express `/api/v1` with a Firebase ID token. Express owns
authorization and writes PostgreSQL through Prisma. Firebase Storage holds
normalized photos, Firebase Auth handles identity, and FCM delivers optional
generic notifications. The Meta Model API is called only from the API. Cloud Run can serve the
built PWA and API from one container; Cloud SQL is the production database.

## Domain consistency

Shared Zod contracts and pure state-machine rules live in `packages/shared`.
Routes validate inputs; services authorize and perform transactions. User IDs,
roles and volunteer permissions never come from trusted client assertions.

Donation approval reserves stock, collection commits it, and cancellation or
expiry releases it. Requests lock the row; community stock also locks the point
and listing. Physical point inventory and linked listing counters change in
the same transaction. A published point listing must be backed by one inventory
item; unbacked legacy listings are paused by migration.

Lending listings contain one unit. Listing locks serialize approvals, with a
PostgreSQL exclusion constraint as a backstop against overlapping dates.
An overdue checked-out item blocks future approvals until returned. Owner and
borrower transitions are checked separately.

Idempotent writes use payload hashes, transaction advisory locks and 24-hour
result records. A reused key with different input is rejected. Notifications,
conversations and stock changes share the domain transaction.

## Ask execution

Private sessions persist messages, typed result cards, image attachments,
drafts, model runs and action proposals. The Meta model uses a bounded streaming tool
loop; visible text/progress is persisted and polled by the client. One active
run per session, cancellation checks and retry keys protect interrupted turns.

Read tools use the same authorized domain services as direct UI controls.
`get_product_guide` reads curated implemented-product facts; `my_account` reads
only the authenticated caller's platform roles, community memberships/statuses
and safe profile preferences. It returns a location-set flag, never home
coordinates or email. A neighbour account label does not imply membership.
Write tools prepare stored review cards. Explicit confirmation executes the
same services using deterministic idempotency keys. Listing edits check the
version captured in the proposal. Execution recovery has a separate lease and
an overall deadline shorter than domain idempotency retention.

Publication combines an AI draft with a secure form for location and pickup
details. Those details are never sent to the model. Confirming publishes the
listing and copies normalized session images into listing storage. A partial
photo failure is recoverable without duplicating the listing.

Saved needs survive chat deletion. Matching loads eligible candidates on the
server, then accepts explanations only for those IDs. The non-AI fallback is
explicitly labeled as filtered matches.

## Privacy and storage

Public listings expose approximate location. Exact pickup data requires the
owner or an authorized approved/historical recipient or borrower. Chat and
session images require ownership/participation. Model-safe tool results omit
exact location, pickup instructions, private addresses and contact fields.

The API decodes and reencodes uploads as bounded WebP, stripping metadata.
Private bucket objects are read through authenticated session routes or
short-lived HMAC listing URLs. Direct client Storage access is denied. No
unauthenticated upload route or local-disk production storage remains.

The PWA service worker caches the app shell only; API responses are no-store.
Explore lazy-loads Leaflet below its title once the saved location is available;
the map starts open and can be hidden. Browser image requests load standard
OpenStreetMap tiles with visible attribution and an origin-only cross-origin
referrer policy. The map draws the caller's saved point/radius and groups
eligible listing pins by rounded public coordinates; no exact listing/pickup
pins or private model data are sent to the tile service.
The app does not prefetch or cache tile areas in its service worker. Tile
failure leaves item search usable. Provider capacity/policy remains a release
consideration; no new API key is required for this view. Manual search radii
accept whole kilometres from 1 to 50; the tenth migration expands the saved
Profile constraint. Ask result cards retain the checked radius and separate
farther eligible matches from nearby results. Radius reply choices draft chat
messages without modifying the Profile preference. See
[playground-seed.md](playground-seed.md) for reproducible accounts, product photos
and full marketplace scenarios.
Mutations require connectivity and are not silently queued offline. The same
worker receives generic opt-in FCM messages and opens only safe app links.

## Background work and deployment

The durable push outbox uses leased `SKIP LOCKED` work, bounded retries and
invalid-token cleanup. Delivery is at least once. Request expiry and orphan
photo cleanup run through `maintenance.ts`. Local API timers are convenient;
production needs a scheduled Cloud Run Job because request-based CPU may stop
background work between requests.

See [integration-handoff.md](integration-handoff.md) for migrations, runtime,
provider configuration and verification limits. Older Engineer 2 planning
documents describe the pre-integration split and are historical context.
