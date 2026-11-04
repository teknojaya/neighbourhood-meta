-- Charity events: new tables only, so the previous revision is unaffected.
CREATE TYPE "CharityEventStatus" AS ENUM ('published', 'cancelled');
CREATE TYPE "EventPledgeStatus" AS ENUM ('pledged', 'accepted', 'received', 'cancelled');
CREATE TYPE "VolunteerSignupStatus" AS ENUM ('pending', 'accepted', 'cancelled');

CREATE TABLE "charity_events" (
  "id" UUID NOT NULL,
  "organizer_id" UUID NOT NULL,
  "status" "CharityEventStatus" NOT NULL DEFAULT 'published',
  "title" VARCHAR(100) NOT NULL,
  "purpose" VARCHAR(2000) NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3),
  "area_label" VARCHAR(120) NOT NULL,
  -- Exact point and drop-off note are private: organizer and accepted contributors only.
  "lat" DOUBLE PRECISION NOT NULL,
  "lng" DOUBLE PRECISION NOT NULL,
  "geohash" VARCHAR(12) NOT NULL,
  "private_note" VARCHAR(1000) NOT NULL DEFAULT '',
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "charity_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "charity_events_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "charity_events_end_after_start" CHECK ("ends_at" IS NULL OR "ends_at" >= "starts_at")
);
CREATE INDEX "charity_events_status_geohash_idx" ON "charity_events" ("status", "geohash" COLLATE "C");
CREATE INDEX "charity_events_organizer_id_created_at_idx" ON "charity_events" ("organizer_id", "created_at");

-- Only organizer-confirmed needs are stored; AI suggestions never are.
CREATE TABLE "event_needs" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "title" VARCHAR(100) NOT NULL,
  "category" "ItemCategory" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "event_needs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_needs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "charity_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_needs_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 10000)
);
CREATE INDEX "event_needs_event_id_idx" ON "event_needs" ("event_id");

CREATE TABLE "event_pledges" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "need_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "note" VARCHAR(300) NOT NULL DEFAULT '',
  "status" "EventPledgeStatus" NOT NULL DEFAULT 'pledged',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "event_pledges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_pledges_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "charity_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_pledges_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "event_needs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_pledges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_pledges_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 10000)
);
CREATE INDEX "event_pledges_need_id_status_idx" ON "event_pledges" ("need_id", "status");
CREATE INDEX "event_pledges_user_id_idx" ON "event_pledges" ("user_id");

CREATE TABLE "volunteer_slots" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "title" VARCHAR(100) NOT NULL,
  "capacity" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "volunteer_slots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "volunteer_slots_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "charity_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "volunteer_slots_capacity_positive" CHECK ("capacity" BETWEEN 1 AND 500)
);
CREATE INDEX "volunteer_slots_event_id_idx" ON "volunteer_slots" ("event_id");

CREATE TABLE "volunteer_signups" (
  "id" UUID NOT NULL,
  "slot_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "VolunteerSignupStatus" NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "volunteer_signups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "volunteer_signups_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "volunteer_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "volunteer_signups_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "charity_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "volunteer_signups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- One live signup per person per slot.
CREATE UNIQUE INDEX "volunteer_signups_one_active" ON "volunteer_signups" ("slot_id", "user_id") WHERE "status" <> 'cancelled';
CREATE INDEX "volunteer_signups_user_id_idx" ON "volunteer_signups" ("user_id");
