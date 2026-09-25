-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "maxUserId" TEXT NOT NULL,
    "maxChatId" TEXT,
    "name" TEXT,
    "username" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "apartments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "houseId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "entrance" INTEGER,
    "floor" INTEGER,
    "accountNumber" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "apartments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "apartments_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "ogrn" TEXT,
    "licenseNumber" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "dispatcherPhone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "workingHours" TEXT,
    "city" TEXT,
    "dataSource" TEXT NOT NULL,
    "dataActualAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "houses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "building" TEXT,
    "normalizedKey" TEXT NOT NULL,
    "fullAddress" TEXT NOT NULL,
    "district" TEXT,
    "gisGuid" TEXT,
    "yearBuilt" INTEGER,
    "floors" INTEGER,
    "entrances" INTEGER,
    "apartmentsCount" INTEGER,
    "wallMaterial" TEXT,
    "totalAreaM2" DECIMAL,
    "managerId" TEXT,
    "capRepairFundType" TEXT,
    "dataSource" TEXT NOT NULL,
    "dataActualAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "houses_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "organizations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tariffs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "houseId" TEXT,
    "service" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "providerName" TEXT,
    "city" TEXT,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "dataSource" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tariffs_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "capital_repair_works" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "houseId" TEXT NOT NULL,
    "workType" TEXT NOT NULL,
    "plannedFrom" INTEGER NOT NULL,
    "plannedTo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "dataSource" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "capital_repair_works_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "responsible_orgs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "orgType" TEXT NOT NULL,
    "responseHours" INTEGER NOT NULL,
    "normativeRef" TEXT,
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "houseId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "orgType" TEXT NOT NULL,
    "organizationId" TEXT,
    "dueAt" DATETIME NOT NULL,
    "reminderSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requests_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requests_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "request_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "request_attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "request_counters" (
    "year" INTEGER NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "data" TEXT NOT NULL DEFAULT '{}',
    "expiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "processed_updates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "processed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_maxUserId_key" ON "users"("maxUserId");

-- CreateIndex
CREATE UNIQUE INDEX "apartments_userId_key" ON "apartments"("userId");

-- CreateIndex
CREATE INDEX "apartments_houseId_idx" ON "apartments"("houseId");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_inn_key" ON "organizations"("inn");

-- CreateIndex
CREATE INDEX "organizations_type_city_idx" ON "organizations"("type", "city");

-- CreateIndex
CREATE UNIQUE INDEX "houses_code_key" ON "houses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "houses_normalizedKey_key" ON "houses"("normalizedKey");

-- CreateIndex
CREATE UNIQUE INDEX "houses_gisGuid_key" ON "houses"("gisGuid");

-- CreateIndex
CREATE INDEX "houses_city_street_idx" ON "houses"("city", "street");

-- CreateIndex
CREATE INDEX "houses_managerId_idx" ON "houses"("managerId");

-- CreateIndex
CREATE INDEX "tariffs_houseId_service_idx" ON "tariffs"("houseId", "service");

-- CreateIndex
CREATE INDEX "tariffs_city_service_idx" ON "tariffs"("city", "service");

-- CreateIndex
CREATE INDEX "capital_repair_works_houseId_idx" ON "capital_repair_works"("houseId");

-- CreateIndex
CREATE UNIQUE INDEX "responsible_orgs_category_key" ON "responsible_orgs"("category");

-- CreateIndex
CREATE UNIQUE INDEX "requests_number_key" ON "requests"("number");

-- CreateIndex
CREATE INDEX "requests_userId_createdAt_idx" ON "requests"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "requests_status_dueAt_reminderSentAt_idx" ON "requests"("status", "dueAt", "reminderSentAt");

-- CreateIndex
CREATE INDEX "request_attachments_requestId_idx" ON "request_attachments"("requestId");

-- CreateIndex
CREATE INDEX "processed_updates_processed_at_idx" ON "processed_updates"("processed_at");
