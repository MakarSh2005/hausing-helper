-- Встроенный чат дома в мини-приложении заменён чатом дома в MAX (групповой чат с ботом)
DROP TABLE IF EXISTS "house_chat_messages";
DROP TABLE IF EXISTS "house_chat_state";

CREATE TABLE "house_chats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "houseId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT,
    "link" TEXT,
    "boundByMaxUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "house_chats_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "houses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "house_chats_houseId_key" ON "house_chats"("houseId");
CREATE UNIQUE INDEX "house_chats_chatId_key" ON "house_chats"("chatId");
