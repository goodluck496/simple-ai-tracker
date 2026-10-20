import type { Repositories } from '../domain/ports.js';
import type { Clock } from './task-service.js';
import { systemClock } from './task-service.js';
import type { Tag, TagWithStats } from '../domain/entities.js';

/** Реестр тегов: используется API, UI и MCP. */
export class TagService {
  public constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock = systemClock,
  ) {}

  public list(): TagWithStats[] {
    return this.repos.tags.listWithStats();
  }

  public add(input: { readonly name: string; readonly color?: string; readonly description?: string }): Tag {
    const name = (input.name ?? '').trim().toLowerCase();
    if (!name) throw new Error('Название тега не может быть пустым.');
    return this.repos.tags.upsert(name, input.color ?? '', input.description ?? '', this.clock.now());
  }

  public update(id: number, patch: { readonly color?: string; readonly description?: string }): Tag | null {
    return this.repos.tags.update(id, patch);
  }

  public remove(name: string): boolean {
    return this.repos.tags.removeByName(name);
  }

  public ensure(names: readonly string[]): Tag[] {
    const now = this.clock.now();
    return names
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
      .map((name) => this.repos.tags.upsert(name, '', '', now));
  }
}
