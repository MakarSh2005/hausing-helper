import { PrismaClient } from '@prisma/client';

export function createDb(): PrismaClient {
  return new PrismaClient();
}

export type Db = PrismaClient;
