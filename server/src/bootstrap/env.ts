import fs from 'node:fs';
import path from 'node:path';
import { findAppRoot } from '../core/config.js';

let loaded = false;

/**
 * Загружает переменные окружения из .env и .env.auth, если они существуют,
 * используя встроенный механизм Node.js process.loadEnvFile().
 */
export function loadEnv(customDir?: string): void {
  if (loaded) return;
  if (typeof process.loadEnvFile !== 'function') return;

  const root = customDir ?? process.env.SAT_HOME ?? findAppRoot();
  const searchDirs = [root];
  if (path.resolve(process.cwd()) !== path.resolve(root)) {
    searchDirs.push(process.cwd());
  }

  for (const dir of searchDirs) {
    for (const name of ['.env', '.env.auth']) {
      const fullPath = path.resolve(dir, name);
      if (fs.existsSync(fullPath)) {
        try {
          process.loadEnvFile(fullPath);
        } catch {
          // Игнорируем ошибки чтения или парсинга
        }
      }
    }
  }

  loaded = true;
}

loadEnv();
