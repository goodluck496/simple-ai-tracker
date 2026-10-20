/**
 * Миграция 001: базовая схема Simple AI Tracker.
 *
 * Нормализованная схема вместо JSON-файлов: задачи, комментарии, вопросы,
 * вложения-планы (с версиями), теги, связи между карточками, журнал событий
 * и полнотекстовый поиск (FTS5).
 */
export const sql = String.raw`
CREATE TABLE IF NOT EXISTS tracker_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  seq                  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  type                 TEXT NOT NULL CHECK (type IN ('feature', 'task', 'bug')),
  status               TEXT NOT NULL CHECK (status IN (
                         'backlog', 'planning', 'questions', 'ready',
                         'in_progress', 'testing', 'review', 'done'
                       )),
  parent_id            TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  position             REAL NOT NULL DEFAULT 0,
  requires_manual_test INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq);
CREATE INDEX IF NOT EXISTS idx_tasks_status_position ON tasks(status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS task_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'planning' CHECK (phase IN ('planning', 'implementation', 'testing')),
  asked_by    TEXT NOT NULL DEFAULT 'AI Agent',
  answer      TEXT,
  answered_at TEXT,
  answered_by TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_questions_task ON task_questions(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS task_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('plan', 'report', 'file')),
  version     INTEGER NOT NULL DEFAULT 1,
  is_current  INTEGER NOT NULL DEFAULT 1,
  content     TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id, kind, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attachments_current_plan
  ON task_attachments(task_id) WHERE kind = 'plan' AND is_current = 1;

CREATE TABLE IF NOT EXISTS task_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_images_task ON task_images(task_id, id);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);

CREATE TABLE IF NOT EXISTS task_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL DEFAULT 'related' CHECK (relation IN (
                   'related', 'blocks', 'blocked_by', 'duplicates', 'duplicated_by'
                 )),
  created_at     TEXT NOT NULL,
  UNIQUE (task_id, linked_task_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_task_links_linked ON task_links(linked_task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'system')),
  summary    TEXT NOT NULL DEFAULT '',
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at, id);

CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
  task_id UNINDEXED,
  title,
  description,
  comments,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export const version = 1;
export const name = 'initial';
