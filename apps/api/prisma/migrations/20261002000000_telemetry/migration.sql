-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "path" TEXT,
    "method" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER,
    "userId" TEXT,
    "role" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryEvent_createdAt_idx" ON "TelemetryEvent"("createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_source_kind_createdAt_idx" ON "TelemetryEvent"("source", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_level_createdAt_idx" ON "TelemetryEvent"("level", "createdAt");

