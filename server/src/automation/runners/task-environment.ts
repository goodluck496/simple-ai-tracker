/** Task commands must not inherit the host worker's tracker store/routing. */
export class TaskEnvironment {
  public static create(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result = { ...source };
    const reserved = new Set(['SAT_WORKSPACE', 'SAT_HOME', 'SAT_DB_PATH', 'SAT_BACKUP_ENABLED',
      'SAT_MCP_COMMAND', 'SAT_MCP_ARGS', 'SAT_CONTAINER']);
    for (const key of Object.keys(result)) if (reserved.has(key.toUpperCase())) delete result[key];
    return result;
  }
}
