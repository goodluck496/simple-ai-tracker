# Simple AI Tracker

Самодостаточный тасктрекер для работы с ИИ-агентами: **SQLite** вместо JSON-файлов, **MCP-сервер** как
единственный канал доступа агента к задачам, **REST API** и **Angular-канбан** для человека.

Проект специально сделан переносимым: каталог можно скопировать в отдельный репозиторий, выполнить
`npm install` — и получить цельное приложение (UI + API + MCP) без зависимостей на другие проекты.

> **Переносишь трекер в другой проект?** Пошаговая инструкция «скопировал → работает» —
> [`GETTING-STARTED.md`](GETTING-STARTED.md). База и схема создаются автоматически при первом запуске.

---

## Что умеет

- Пространства проектов и независимые команды агентов: [настройка и запуск worker](docs/automation.md).

- **Карточки задач** (фича / задача / баг) с описанием, тегами, связями (`related`, `blocks`, `blocked_by`,
  `duplicates`), подзадачами и деревом «фича → подзадачи».
- **8 стадий жизненного цикла:** `backlog → planning → questions → ready → in_progress → testing → review → done`.
  Переходы валидируются на сервере: агент идёт строго по регламенту, а `done` ставит **только пользователь**.
- **Вопросы в карточке:** агент задаёт их через MCP, карточка уходит в `questions` и ждёт ответа; ответы
  пользователя (в UI или в чате) возвращают её в работу.
- **Планы версионируются:** каждый план — markdown-вложение с номером версии; в карточке видна история
  «от чего шли и к чему пришли».
- **Журнал решений (decision log):** уточнения пользователя, версии планов и смены статусов в хронологии —
  даже если агент «сбился», полный след сохраняется в карточке.
- **Полнотекстовый поиск (SQLite FTS5)** по заголовку, описанию, комментариям, тегам и ID.
- **MCP-сервер (stdio)** с 19 инструментами и жёсткими инструкциями: агент работает с задачами только через них.
- **Импорт/экспорт:** перенос из legacy JSON-хранилища и обратно (JSON + markdown-карточки).

## Быстрый старт

```bash
npm install                 # полная установка (UI + MCP)
npm install --omit=dev      # только MCP: SDK + esbuild
npm run doctor              # диагностика: пути, база, схема, MCP, UI, бэкапы
npm run build:server        # esbuild → dist/server (api.mjs, mcp.mjs, cli.mjs)
npm run build:web           # Angular → dist/web
npm start                   # http://127.0.0.1:4317 (API + UI)
```

Первый запуск любого компонента (CLI, API или MCP) сам создаёт `data/tracker.db`, применяет миграции
и поднимает FTS-индекс. Отдельной инициализации базы не требуется.

Разработка UI с hot-reload:

```bash
npm run dev:api             # API на 4317
npm run serve:web           # Angular dev-сервер на 4318, /api проксируется на 4317
```

Проверки:

```bash
npm test                    # unit/integration тесты (node:test + tsx)
npm run typecheck           # строгая проверка типов сервера
npm run build:server        # обязательно перед smoke:mcp
npm run smoke:mcp           # дымовой тест MCP: инструменты, инструкции, чтение карточки
```

## Структура

```
server/src/
  core/          конфигурация, логгер (только stderr — stdout занят MCP), ошибки домена
  domain/        сущности, статусы и правила переходов, порты репозиториев
  db/            драйвер SQLite (абстракция + адаптер node:sqlite), миграции, репозитории
  services/      TaskService (жизненный цикл), ContextService (контекст-пак агента),
                 ImportService/ExportService, VerificationService, InstructionsService
  api/           HTTP-роутер, REST-маршруты, раздача собранного UI
  mcp/           определения и обработчики MCP-инструментов, stdio-сервер
  bootstrap/     сборка зависимостей (container) и точки входа: api / mcp / cli
web/src/app/
  models/        типы, зеркалящие серверный домен
  services/      TrackerApiService (HTTP) и TrackerStore (signals)
  components/    board, task-dialog, plan-viewer, questions-panel, decision-log, toolbar, tags-panel
  shared/        безопасный markdown-рендер и форматирование дат
AGENT_INSTRUCTIONS.md   жёсткие правила для агента (копируется в AGENTS.md проекта-потребителя)
mcp.config.example.json пример конфигурации MCP-клиента
data/tracker.db         рабочая база SQLite (в git не попадает)
```

## Подключение к проекту-потребителю

1. Установите зависимости: `npm install --omit=dev` (для MCP) или `npm install` (для UI).
2. Добавьте MCP-сервер в конфигурацию агента (см. `mcp.config.example.json`):

```json
{
  "mcpServers": {
    "simple-ai-tracker": {
      "command": "node",
      "args": ["/абсолютный/путь/simple-ai-tracker/scripts/mcp-launcher.mjs"]
    }
  }
}
```

`scripts/mcp-launcher.mjs` при первом запуске сам собирает бандл сервера (и пересобирает, если исходники
новее), поэтому ручной `npm run build:server` не нужен. Альтернатива — собрать заранее и указать
`dist/server/mcp.mjs`.

3. Скопируйте раздел «Правила работы с тасктрекером» из [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md)
   в инструкцию проекта (`AGENTS.md`, `CLAUDE.md`, правил Cursor и т.п.).

Агент, увидев эти правила, работает с задачами **только через MCP**: без `grep`, чтения `tasks/*.json`
и прямых запросов к базе. Полный регламент работы (шаги 1–9, уточнения, тесты, `done`) — в
`AGENT_INSTRUCTIONS.md`; этот же текст MCP-сервер отдаёт в поле `instructions` и через
`tracker_get_instructions`.

## MCP-инструменты

| Инструмент | Назначение |
|---|---|
| `tracker_get_instructions` | инструкция по работе с трекером |
| `tracker_get_task` | контекст-пак: описание, связи, план + история, вопросы, журнал решений |
| `tracker_list_tasks` / `tracker_search_tasks` | список и полнотекстовый поиск |
| `tracker_get_next_task` | взять следующую готовую задачу |
| `tracker_create_task` / `tracker_update_task` | создание и правка карточек |
| `tracker_set_status` | смена статуса по регламенту (`done` — только пользователь) |
| `tracker_add_comment` | комментарий в историю |
| `tracker_ask_questions` / `tracker_answer_questions` | вопросы и фиксация ответов |
| `tracker_attach_plan` | приложить план с автоинкрементом версии |
| `tracker_record_clarification` | уточнение пользователя + пересборка решения |
| `tracker_add_attachment` | отчёт о тестах и прочие файлы |
| `tracker_link_tasks` / `tracker_unlink_tasks` | связи карточек |
| `tracker_list_tags` / `tracker_add_tag` | теги |
| `tracker_verify_task` | компактная проверка целостности карточки |

## Схема базы данных

Миграции — `server/src/db/migrations/*.ts` (версия схемы хранится в `PRAGMA user_version`).

- `tasks` — карточки: `id`, `seq`, `title`, `description`, `type`, `status`, `parent_id`, `position`,
  `requires_manual_test`, даты.
- `task_comments` — история с видом (`note`, `status`, `requirement`, `clarification`, `plan`,
  `test-report`, `answer`, `system`).
- `task_questions` — вопросы и ответы (`phase`, `answer`, `answered_at`, `answered_by`).
- `task_attachments` — вложения; планы (`kind='plan'`) версионируются, текущая версия помечена `is_current`.
- `task_images`, `tags`, `task_tags`, `task_links`, `task_events` (журнал решений), `tracker_meta`.
- `task_search` — виртуальная таблица FTS5, поддерживается при каждой записи.

Драйвер SQLite спрятан за интерфейсом `SqlDatabase` (`server/src/db/sql-database.ts`), поэтому замена
`node:sqlite` на `better-sqlite3` или `libsql` не затрагивает домен и сервисы.

## Миграция из JSON-хранилища

```bash
npm run import:json -- --source ../game1                  # первичный перенос
npm run import:json -- --source ../game1 --replace        # пере-импорт с очисткой
npm run export:json -- --out ./export                     # бэкап в JSON + markdown
```

Импорт читает `tasks.json`, `tasks/*.json`, `tags.json`, подтягивает содержимое планов из файлов
(`docs/plans/*.md`) и восстанавливает журнал решений из префиксов legacy-комментариев
(`[USER REQUIREMENTS]`, `[PENDING]`, `[TEST]` и т.д.). Отчёт печатается компактным JSON.

## Резервное копирование

Снимок базы делается через SQLite `VACUUM INTO` — копия целостная, без WAL/SHM, сервер
останавливать не нужно.

- **Автоматически:** при старте API и далее по интервалу, но **не чаще двух раз в сутки**
  (`SAT_BACKUP_MAX_PER_DAY`, по умолчанию `2`) и не чаще интервала `SAT_BACKUP_INTERVAL_HOURS`
  (по умолчанию `12` ч). Снимки не привязаны к сохранению карточки: правки карточек бэкап не запускают.
  Ротация оставляет `SAT_BACKUP_KEEP` последних копий (по умолчанию 20). Отключается `SAT_BACKUP_ENABLED=false`.
- **Вручную из UI:** маленькая кнопка облака в шапке — создать, скачать, удалить снимок (ручной снимок
  суточным лимитом не ограничен).
- **Вручную из CLI:**

```bash
npm run db:backup              # снимок в data/backups/tracker-YYYY-MM-DD_HH-mm-ss.db
npm run db:backup -- --export  # снимок + JSON/markdown-экспорт в export/<метка>/
npm run db:backups             # список копий, каталог и настройки ротации
npm run db:restore -- --file tracker-2026-10-19_15-04-12.db   # сервер должен быть остановлен
```

Восстановление сначала снимает `pre-restore` копию текущего состояния, затем подменяет файл базы —
откат всегда обратим. REST API: `POST /api/admin/backup`, `GET /api/admin/backups`,
`GET /api/admin/backups/<name>/download`, `DELETE /api/admin/backups/<name>`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SAT_HOME` | корень приложения | каталог приложения (поиск конфигурации/инструкций) |
| `SAT_DB_PATH` | `data/tracker.db` | путь к файлу SQLite |
| `SAT_PORT` | `4317` | порт HTTP API + UI |
| `SAT_HOST` | `127.0.0.1` | хост HTTP-сервера |
| `SAT_ID_PREFIX` | `SAT` | префикс ID новых задач (`SAT-1`, `SAT-2`, …) |
| `SAT_BACKUP_ENABLED` | `true` | автоматические бэкапы |
| `SAT_BACKUP_INTERVAL_HOURS` | `12` | минимальный интервал авто-бэкапов |
| `SAT_BACKUP_MAX_PER_DAY` | `2` | предел авто-бэкапов за сутки (`0` — без предела) |
| `SAT_BACKUP_KEEP` | `20` | сколько последних копий хранить |

> `node:sqlite` помечен в Node как экспериментальный и печатает предупреждение в stderr — на работу не влияет.
> Требуется Node.js ≥ 22.5.
