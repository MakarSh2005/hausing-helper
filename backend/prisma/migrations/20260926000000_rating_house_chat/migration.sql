-- Оценка заявки жильцом после закрытия
ALTER TABLE "requests" ADD COLUMN "rating" INTEGER;
ALTER TABLE "requests" ADD COLUMN "ratingComment" TEXT;
ALTER TABLE "requests" ADD COLUMN "ratedAt" DATETIME;
CREATE INDEX "requests_organizationId_rating_idx" ON "requests"("organizationId", "rating");

-- Фото профиля MAX — для чата дома
ALTER TABLE "users" ADD COLUMN "photoUrl" TEXT;

-- Чат дома
CREATE TABLE "house_chat_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "houseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "house_chat_messages_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "house_chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "house_chat_messages_houseId_createdAt_idx" ON "house_chat_messages"("houseId", "createdAt");

CREATE TABLE "house_chat_state" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "lastReadAt" DATETIME,
    "lastNotifiedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "house_chat_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
