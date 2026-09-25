// Создаёт ../.env из ../.env.example, если его ещё нет, и подсказывает, что заполнить.
// Работает одинаково на Windows, macOS и Linux.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = path.join(root, '.env');
const example = path.join(root, '.env.example');

if (fs.existsSync(env)) {
  const text = fs.readFileSync(env, 'utf8');
  const token = /^MAX_BOT_TOKEN=(.*)$/m.exec(text)?.[1]?.trim();
  console.log(token ? '.env найден, токен заполнен.' : '.env найден, но MAX_BOT_TOKEN пустой — впишите токен перед запуском бота.');
} else {
  fs.copyFileSync(example, env);
  console.log('Создан файл .env в корне проекта.');
  console.log('Откройте его и впишите токен бота после MAX_BOT_TOKEN= (без пробелов и кавычек).');
}
