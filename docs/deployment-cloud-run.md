# Cloud Run + Cloud SQL deployment

Nothing in this document has been executed against Google Cloud. It is the
reviewed command sequence for a first release of the single-container app
(API + built PWA) on Cloud Run, PostgreSQL 17 on Cloud SQL, Firebase
Auth/Storage/FCM and server-side Meta Model API. Run it from a clean checkout of the
commit you intend to release, as an operator who owns the project.

## What the runtime needs

| Concern | Production setting |
|---|---|
| Identity for Google APIs | The **attached runtime service account**. Never set `GOOGLE_APPLICATION_CREDENTIALS` on Cloud Run and never copy a key JSON or its path into an image, build arg or env var. |
| Database | Cloud SQL socket URL `postgresql://USER:PASSWORD@localhost/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`, held in Secret Manager. |
| Connection budget | `DATABASE_POOL_MAX` (default 10) × max instances + job pools must stay below the instance's `max_connections` (db-f1-micro 25, db-g1-small 50). Suggested start: service pool 5 × max 4 instances, jobs pool 2. |
| Photos | Private Firebase bucket; deny-all `storage.rules`. The API reads/writes with Admin credentials and serves photos through authenticated routes or short-lived HMAC links. |
| Photo link signing | `STORAGE_SIGNING_SECRET` ≥ 32 random characters, one value shared by every instance. The server refuses to start in production without it. |
| Email OTP | `OTP_SECRET` + SMTP settings. The server mints Firebase custom tokens; with an attached service account that uses IAM `signBlob`, so **`iamcredentials.googleapis.com` must be enabled** and the runtime SA needs Token Creator on itself. |
| Push | `PUSH_ENABLED=true` only after `VITE_FIREBASE_VAPID_KEY` is built in and FCM is verified. |
| Health | `GET /healthz` (no dependencies). The default TCP startup probe works; an HTTP probe on `/healthz` can be added in the service YAML/console. |
| Background work | `node apps/api/dist/maintenance.js` as a Cloud Run Job, scheduled every minute. Request expiry, the push outbox and photo cleanup depend on it. |
| Emulators | Must be absent. The server refuses `USE_FIREBASE_EMULATORS=true` or any `*_EMULATOR_HOST` when `NODE_ENV=production` or `K_SERVICE` is set. |

## Pre-flight (local, no cloud changes)

```sh
npm ci
npm run check                       # types, lint, unit tests, builds
npm run test:db                     # only against the disposable TEST_DATABASE_URL
git status --short                  # every migration under apps/api/prisma/migrations must be tracked
```

Docker images built from a working tree include untracked files. Build release
images only from a clean checkout so the image's migrations equal Git's.

## 1. Variables

```sh
PROJECT=neighbourhood-web-app
REGION=asia-southeast2                       # Jakarta; choose deliberately
INSTANCE=neighbourhood-pg
DB=neighbourhood
DB_USER=neighbourhood
CONN=$PROJECT:$REGION:$INSTANCE
BUCKET=neighbourhood-web-app.firebasestorage.app
SA=neighbourhood-run@$PROJECT.iam.gserviceaccount.com
SCHED_SA=neighbourhood-scheduler@$PROJECT.iam.gserviceaccount.com
REPO=$REGION-docker.pkg.dev/$PROJECT/neighbourhood
TAG=$(git rev-parse --short HEAD)
```

## 2. APIs, registry, service accounts

```sh
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com iamcredentials.googleapis.com \
  identitytoolkit.googleapis.com fcm.googleapis.com \
  firebasestorage.googleapis.com storage.googleapis.com --project $PROJECT

gcloud artifacts repositories create neighbourhood --repository-format=docker \
  --location=$REGION --project $PROJECT

gcloud iam service-accounts create neighbourhood-run --project $PROJECT
gcloud iam service-accounts create neighbourhood-scheduler --project $PROJECT

for ROLE in roles/cloudsql.client roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=$ROLE
done
# Custom tokens for email OTP (IAM signBlob on itself).
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator --project $PROJECT
# Only when push is enabled:
# gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/firebasecloudmessaging.admin
```

## 3. Storage

Create the default bucket in Firebase console → Build → Storage → Get started
(locked/production mode), then:

```sh
gcloud storage buckets update gs://$BUCKET --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$SA --role=roles/storage.objectUser
npx firebase deploy --only storage --project $PROJECT     # deny-all storage.rules
```

## 4. Cloud SQL

```sh
gcloud sql instances create $INSTANCE --database-version=POSTGRES_17 \
  --edition=ENTERPRISE --tier=db-g1-small --region=$REGION \
  --backup-start-time=18:00 --enable-point-in-time-recovery --project $PROJECT
gcloud sql databases create $DB --instance=$INSTANCE --project $PROJECT
DB_PASSWORD=$(openssl rand -base64 30 | tr -d '/+=')
gcloud sql users create $DB_USER --instance=$INSTANCE --password="$DB_PASSWORD" --project $PROJECT
```

Migrations create the `btree_gist` extension; users created this way have the
`cloudsqlsuperuser` role, which is permitted to create it.

## 5. Secrets (values never on the command line history of shared machines)

```sh
printf '%s' "postgresql://$DB_USER:$DB_PASSWORD@localhost/$DB?host=/cloudsql/$CONN" \
  | gcloud secrets create nh-database-url --data-file=- --project $PROJECT
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create nh-storage-signing-secret --data-file=- --project $PROJECT
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create nh-otp-secret --data-file=- --project $PROJECT
gcloud secrets create nh-meta-api-key --data-file=/secure/path/meta-key.txt --project $PROJECT
gcloud secrets create nh-smtp-password  --data-file=/secure/path/smtp-password.txt --project $PROJECT
unset DB_PASSWORD

for S in nh-database-url nh-storage-signing-secret nh-otp-secret nh-meta-api-key nh-smtp-password; do
  gcloud secrets add-iam-policy-binding $S --member=serviceAccount:$SA \
    --role=roles/secretmanager.secretAccessor --project $PROJECT
done
```

## 6. Build and push images (public web identifiers only)

`VITE_FIREBASE_*` values are public identifiers from Firebase console → Project
settings → Your apps. No server secret is ever a build arg.

```sh
gcloud auth configure-docker $REGION-docker.pkg.dev
export VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=$PROJECT.firebaseapp.com \
  VITE_FIREBASE_PROJECT_ID=$PROJECT VITE_FIREBASE_STORAGE_BUCKET=$BUCKET \
  VITE_FIREBASE_MESSAGING_SENDER_ID=... VITE_FIREBASE_APP_ID=... VITE_FIREBASE_VAPID_KEY=
ARGS="--build-arg VITE_FIREBASE_API_KEY --build-arg VITE_FIREBASE_AUTH_DOMAIN \
  --build-arg VITE_FIREBASE_PROJECT_ID --build-arg VITE_FIREBASE_STORAGE_BUCKET \
  --build-arg VITE_FIREBASE_MESSAGING_SENDER_ID --build-arg VITE_FIREBASE_APP_ID \
  --build-arg VITE_FIREBASE_VAPID_KEY"
docker build --target runtime $ARGS -t $REPO/app:$TAG .
docker build --target migrate -t $REPO/migrate:$TAG .
docker push $REPO/app:$TAG && docker push $REPO/migrate:$TAG
```

## 7. Migrate before serving

```sh
gcloud run jobs create neighbourhood-migrate --image=$REPO/migrate:$TAG --region=$REGION \
  --service-account=$SA --set-cloudsql-instances=$CONN \
  --set-secrets=DATABASE_URL=nh-database-url:latest --max-retries=0 --task-timeout=600 --project $PROJECT
gcloud run jobs execute neighbourhood-migrate --region=$REGION --wait --project $PROJECT
```

On later releases use `gcloud run jobs update neighbourhood-migrate --image=$REPO/migrate:$TAG ...`
and execute it before deploying the service.

## 8. Service

```sh
COMMON_ENV=NODE_ENV=production,FIREBASE_PROJECT_ID=$PROJECT,FIREBASE_STORAGE_BUCKET=$BUCKET,META_MODEL=muse-spark-1.3,PUSH_ENABLED=false
SMTP_ENV=SMTP_HOST=smtp.example.com,SMTP_PORT=587,SMTP_SECURE=false,SMTP_USER=apikey,EMAIL_FROM=NeighbourHood\ \<no-reply@example.com\>
SECRETS=DATABASE_URL=nh-database-url:latest,STORAGE_SIGNING_SECRET=nh-storage-signing-secret:latest,OTP_SECRET=nh-otp-secret:latest,META_API_KEY=nh-meta-api-key:latest,SMTP_PASSWORD=nh-smtp-password:latest

gcloud run deploy neighbourhood --image=$REPO/app:$TAG --region=$REGION \
  --service-account=$SA --add-cloudsql-instances=$CONN \
  --set-env-vars="$COMMON_ENV,$SMTP_ENV,DATABASE_POOL_MAX=5" --set-secrets="$SECRETS" \
  --cpu=1 --memory=1Gi --concurrency=40 --min-instances=0 --max-instances=4 \
  --allow-unauthenticated --project $PROJECT
```

Omit `SMTP_ENV`, `OTP_SECRET` and `SMTP_PASSWORD` until a real sender is ready;
the app then reports email codes as unavailable instead of failing.

## 9. Scheduled maintenance

```sh
gcloud run jobs create neighbourhood-maintenance --image=$REPO/app:$TAG --region=$REGION \
  --command=node --args=apps/api/dist/maintenance.js \
  --service-account=$SA --set-cloudsql-instances=$CONN \
  --set-env-vars="$COMMON_ENV,DATABASE_POOL_MAX=2" \
  --set-secrets=DATABASE_URL=nh-database-url:latest,STORAGE_SIGNING_SECRET=nh-storage-signing-secret:latest \
  --max-retries=0 --task-timeout=300 --project $PROJECT
gcloud run jobs add-iam-policy-binding neighbourhood-maintenance --region=$REGION \
  --member=serviceAccount:$SCHED_SA --role=roles/run.invoker --project $PROJECT
gcloud scheduler jobs create http neighbourhood-maintenance --location=$REGION --schedule="* * * * *" \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/neighbourhood-maintenance:run" \
  --http-method=POST --oauth-service-account-email=$SCHED_SA --project $PROJECT
```

Overlapping executions are safe: outbox work uses leased `SKIP LOCKED` rows and
domain transitions are transactional. Failures log `maintenance_failed` with the
error class/code only.

## 10. Firebase Auth

- Firebase console → Authentication → Sign-in method: Google enabled.
- Settings → Authorized domains: add the `*.run.app` service host and any custom domain.
- Sign-in uses a popup (the server sends `Cross-Origin-Opener-Policy:
  same-origin-allow-popups` so the popup can report back). The redirect
  fallback for popup-blocking browsers depends on third-party storage access to
  `authDomain`; for installed iOS/Safari PWAs, plan a custom domain as `authDomain`.

## 11. Release verification (manual, after deploy)

1. `curl -fsS https://SERVICE_URL/healthz` → `{"status":"ok"}`.
2. Sign in with Google on a phone and a desktop browser; set Profile location; sign out.
3. Publish a listing with a photo; open it from a second account; request, approve, collect.
4. Confirm a photo URL without a valid signature returns 403/404, and that
   `gs://$BUCKET` objects are not publicly readable.
5. Check Cloud Logging for `maintenance_completed` once per minute.
6. Email OTP and push: only after real SMTP/VAPID configuration, using recipients
   who agreed to receive test messages.

## Rollback

`gcloud run services update-traffic neighbourhood --to-revisions=PREVIOUS=100`.
Migrations are forward-only; write a new migration rather than editing an applied one.
