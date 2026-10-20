import type { Repositories } from '../../domain/ports.js';
import type { SqlDatabase } from '../sql-database.js';
import { SqliteTaskQueryRepository, SqliteTaskRepository } from './task.repository.js';
import { SqliteCommentRepository } from './comment.repository.js';
import { SqliteQuestionRepository } from './question.repository.js';
import { SqliteAttachmentRepository } from './attachment.repository.js';
import { SqliteImageRepository } from './image.repository.js';
import { SqliteTagRepository } from './tag.repository.js';
import { SqliteLinkRepository } from './link.repository.js';
import { SqliteEventRepository } from './event.repository.js';
import { SqliteSearchIndex } from './search.index.js';
import { SqliteMetaRepository } from './meta.repository.js';

/** Собирает все SQLite-репозитории над одним соединением. */
export function createRepositories(db: SqlDatabase): Repositories {
  return {
    tasks: new SqliteTaskRepository(db),
    taskQueries: new SqliteTaskQueryRepository(db),
    comments: new SqliteCommentRepository(db),
    questions: new SqliteQuestionRepository(db),
    attachments: new SqliteAttachmentRepository(db),
    images: new SqliteImageRepository(db),
    links: new SqliteLinkRepository(db),
    events: new SqliteEventRepository(db),
    tags: new SqliteTagRepository(db),
    search: new SqliteSearchIndex(db),
    meta: new SqliteMetaRepository(db),
  };
}
