/** Task commands must not inherit the host worker's tracker store/routing. */
export class TaskEnvironment {
  public static create(source: NodeJS.ProcessEnv = ExecutionScope.current?.env ?? process.env): NodeJS.ProcessEnv {
    const result = { ...source };
    const reserved = new Set(['SAT_WORKSPACE', 'SAT_HOME', 'SAT_DB_PATH', 'SAT_BACKUP_ENABLED',
      'SAT_MCP_COMMAND', 'SAT_MCP_ARGS', 'SAT_CONTAINER', 'DATABASE_URL', 'DATABASE_URI', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
      'MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'MONGODB_URI', 'MONGO_URL', 'REDIS_URL']);
    for (const key of Object.keys(result)) if (reserved.has(key.toUpperCase())) delete result[key];
    return result;
  }
  public static git(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = { ...source };
    for (const key of Object.keys(result)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) delete result[key];
    return result;
  }
}
import { ExecutionScope } from './execution-scope.js';
