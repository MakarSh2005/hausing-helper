-- Адрес на момент подачи заявки (снимок): перепривязка квартиры не меняет старые заявки.
ALTER TABLE "requests" ADD COLUMN "address" TEXT;
