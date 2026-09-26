-- Вложения в чате дома: фото, голосовые, файлы
ALTER TABLE "house_chat_messages" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "house_chat_messages" ADD COLUMN "file" TEXT;
ALTER TABLE "house_chat_messages" ADD COLUMN "fileName" TEXT;
ALTER TABLE "house_chat_messages" ADD COLUMN "fileSize" INTEGER;
ALTER TABLE "house_chat_messages" ADD COLUMN "mime" TEXT;
ALTER TABLE "house_chat_messages" ADD COLUMN "duration" INTEGER;
