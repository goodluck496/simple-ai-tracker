#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PATCHES_DIR_NAME = 'patches';

function runGit(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function getRepoRoot() {
  const res = runGit(['rev-parse', '--show-toplevel']);
  if (res.status !== 0) throw new Error('Not inside a Git repository.');
  return res.stdout.trim();
}

function parseStatus(cwd) {
  const res = runGit(['status', '--porcelain=v1'], cwd);
  if (res.status !== 0) throw new Error(`git status failed: ${res.stderr}`);
  const lines = res.stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
  const modified = [];
  const untracked = [];
  const staged = [];

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();

    // Ignore patches directory itself
    if (file.startsWith(PATCHES_DIR_NAME + '/') || file.startsWith(PATCHES_DIR_NAME + '\\') || file.endsWith('.patch')) {
      continue;
    }

    if (x === '?' && y === '?') {
      untracked.push(file);
    } else {
      if (x !== ' ' && x !== '?') staged.push(file);
      if (y !== ' ' && y !== '?') modified.push(file);
    }
  }

  const allChanged = Array.from(new Set([...staged, ...modified, ...untracked]));
  return {
    clean: allChanged.length === 0,
    staged,
    modified,
    untracked,
    allChanged,
    count: allChanged.length
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function commandCheck(flags) {
  const root = getRepoRoot();
  const status = parseStatus(root);
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (status.clean) {
    console.log('✅ Рабочая копия чиста, незакоммиченных изменений нет.');
  } else {
    console.log(`⚠️ Обнаружены незакоммиченные изменения (${status.count} файлов):`);
    if (status.staged.length) console.log(`  В индексе (staged): ${status.staged.join(', ')}`);
    if (status.modified.length) console.log(`  Изменены (modified): ${status.modified.join(', ')}`);
    if (status.untracked.length) console.log(`  Новые (untracked): ${status.untracked.join(', ')}`);
  }
}

function commandSave(nameArg, flags) {
  const root = getRepoRoot();
  const status = parseStatus(root);

  if (status.clean) {
    if (flags.json) {
      console.log(JSON.stringify({ status: 'clean', message: 'No uncommitted changes to save.' }));
    } else {
      console.log('Рабочая копия чиста. Нет изменений для сохранения в патч.');
    }
    return;
  }

  const patchesDir = path.join(root, PATCHES_DIR_NAME);
  ensureDir(patchesDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_');
  const baseName = (nameArg ? nameArg.replace(/[^a-zA-Z0-9_-]/g, '_') : `patch_${timestamp}`).replace(/\.patch$/, '');
  const patchFileName = `${baseName}.patch`;
  const metaFileName = `${baseName}.json`;
  const patchFilePath = path.join(patchesDir, patchFileName);
  const metaFilePath = path.join(patchesDir, metaFileName);

  // Stage intent-to-add for untracked files to include them in diff
  runGit(['add', '-N', '.'], root);

  // Generate unified diff
  const diffRes = runGit(['diff', 'HEAD'], root);
  const diffText = diffRes.status === 0 ? diffRes.stdout : runGit(['diff'], root).stdout;

  // Reset intent-to-add
  runGit(['reset'], root);

  if (!diffText.trim()) {
    console.error('Ошибка: не удалось сформировать diff изменений.');
    process.exit(1);
  }

  // Write patch file
  fs.writeFileSync(patchFilePath, diffText, 'utf8');

  // Metadata
  let currentBranch = '';
  let currentHead = '';
  try { currentBranch = runGit(['branch', '--show-current'], root).stdout.trim(); } catch {}
  try { currentHead = runGit(['rev-parse', 'HEAD'], root).stdout.trim(); } catch {}

  const meta = {
    patchFile: patchFileName,
    patchPath: path.relative(root, patchFilePath).replace(/\\/g, '/'),
    createdAt: new Date().toISOString(),
    branch: currentBranch,
    baseSha: currentHead,
    files: status.allChanged,
    applied: false
  };

  fs.writeFileSync(metaFilePath, JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(patchesDir, 'latest.json'), JSON.stringify(meta, null, 2), 'utf8');

  // Clean working tree so work can proceed
  runGit(['checkout', '--', '.'], root);
  runGit(['clean', '-fd', '-e', PATCHES_DIR_NAME, '-e', `*.patch`], root);

  const relativePatch = path.relative(root, patchFilePath).replace(/\\/g, '/');

  if (flags.json) {
    console.log(JSON.stringify({ status: 'saved', patchFile: relativePatch, files: status.allChanged }));
  } else {
    console.log(`\n✅ Локальные изменения успешно сохранены в файл патча!`);
    console.log(`📁 Файл патча: ${relativePatch}`);
    console.log(`📄 Сохранено файлов: ${status.allChanged.length}`);
    status.allChanged.forEach(f => console.log(`   - ${f}`));
    console.log(`\nРабочая копия очищена для выполнения задачи.`);
    console.log(`Для восстановления после завершения работы выполните:`);
    console.log(`  node scripts/manage-patch.mjs restore ${relativePatch}\n`);
  }
}

function commandRestore(patchArg, flags) {
  const root = getRepoRoot();
  const patchesDir = path.join(root, PATCHES_DIR_NAME);

  let targetPath = patchArg;
  if (!targetPath) {
    const latestFile = path.join(patchesDir, 'latest.json');
    if (fs.existsSync(latestFile)) {
      try {
        const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
        if (latest.patchFile) {
          targetPath = path.join(patchesDir, latest.patchFile);
        }
      } catch {}
    }
  }

  if (!targetPath) {
    // Look for newest .patch in patchesDir
    if (fs.existsSync(patchesDir)) {
      const files = fs.readdirSync(patchesDir).filter(f => f.endsWith('.patch'));
      if (files.length) {
        files.sort((a, b) => {
          const sa = fs.statSync(path.join(patchesDir, a)).mtimeMs;
          const sb = fs.statSync(path.join(patchesDir, b)).mtimeMs;
          return sb - sa;
        });
        targetPath = path.join(patchesDir, files[0]);
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    const err = `Файл патча не найден: ${targetPath || 'нет сохранённых патчей'}`;
    if (flags.json) {
      console.log(JSON.stringify({ status: 'error', error: err }));
    } else {
      console.error(`❌ ${err}`);
    }
    process.exit(1);
  }

  const relativePatch = path.relative(root, targetPath).replace(/\\/g, '/');

  // Try applying with 3way
  let applyRes = runGit(['apply', '--3way', targetPath], root);
  if (applyRes.status !== 0) {
    // Try simple apply
    applyRes = runGit(['apply', targetPath], root);
  }

  const metaPath = targetPath.replace(/\.patch$/, '.json');

  if (applyRes.status === 0) {
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.applied = true;
        meta.appliedAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      } catch {}
    }

    if (flags.json) {
      console.log(JSON.stringify({ status: 'restored', patchFile: relativePatch }));
    } else {
      console.log(`\n✅ Патч успешно восстановлен в рабочую копию: ${relativePatch}`);
    }
  } else {
    const conflictInfo = applyRes.stderr || applyRes.stdout;
    if (flags.json) {
      console.log(JSON.stringify({
        status: 'conflict',
        patchFile: relativePatch,
        error: conflictInfo,
        retained: true
      }));
    } else {
      console.error(`\n⚠️ ВНИМАНИЕ: Автоматическое применение патча завершилось с конфликтами!`);
      console.error(`📄 Файл патча СОХРАНЁН и НЕ УДАЛЁН: ${relativePatch}`);
      console.error(`Подробности конфликта:\n${conflictInfo}`);
      console.error(`\nВы можете применить оставшиеся части вручную:`);
      console.error(`  git apply --reject ${relativePatch}\n`);
    }
    process.exit(1);
  }
}

function commandList(flags) {
  const root = getRepoRoot();
  const patchesDir = path.join(root, PATCHES_DIR_NAME);

  if (!fs.existsSync(patchesDir)) {
    if (flags.json) console.log(JSON.stringify([]));
    else console.log('Папка патчей пуста (нет сохранённых патчей).');
    return;
  }

  const files = fs.readdirSync(patchesDir).filter(f => f.endsWith('.patch'));
  const items = files.map(file => {
    const patchPath = path.join(patchesDir, file);
    const metaPath = path.join(patchesDir, file.replace(/\.patch$/, '.json'));
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    }
    const stat = fs.statSync(patchPath);
    return {
      file,
      createdAt: meta.createdAt || stat.mtime.toISOString(),
      applied: !!meta.applied,
      files: meta.files || []
    };
  });

  if (flags.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (!items.length) {
    console.log('Сохранённых патчей нет.');
    return;
  }

  console.log(`Сохранённые патчи (${items.length}):`);
  for (const item of items) {
    const status = item.applied ? ' [применён]' : ' [не применён]';
    console.log(`  • ${item.file} (${item.createdAt})${status} — файлов: ${item.files.length}`);
  }
}

function showHelp() {
  console.log(`
Использование: node scripts/manage-patch.mjs <команда> [аргументы] [флаги]

Команды:
  check                  Проверить рабочую копию на незакоммиченные изменения
  save [имя-патча]       Сохранить незакоммиченные изменения в файл патча и очистить дерево
  restore [путь-к-файлу] Восстановить изменения из файла патча (по умолчанию — последний)
  list                   Показать список всех сохранённых патчей

Флаги:
  --json                 Вывод результата в формате JSON
  --help                 Справка
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';
  const flags = {
    json: args.includes('--json')
  };
  const nonFlags = args.slice(1).filter(a => !a.startsWith('--'));

  switch (command) {
    case 'check':
    case 'status':
      commandCheck(flags);
      break;
    case 'save':
    case 'create':
      commandSave(nonFlags[0], flags);
      break;
    case 'restore':
    case 'apply':
      commandRestore(nonFlags[0], flags);
      break;
    case 'list':
      commandList(flags);
      break;
    case 'help':
    case '--help':
      showHelp();
      break;
    default:
      console.error(`Неизвестная команда: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main();
