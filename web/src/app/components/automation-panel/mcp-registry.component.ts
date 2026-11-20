import { Component, EventEmitter, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { validMcp, type ProjectMcp } from '../../../../../shared/automation/project-mcp';

interface RegistryServer {
  name: string;
  description?: string;
  repository?: {url?:string};
  remotes?: {type:string; url:string; headers?: {name:string; value?:string; isRequired?:boolean}[]}[];
}
interface RegistryEntry {
  name: string;
  description?: string;
  source?: string;
  connection?: ProjectMcp;
}
function entry(server: RegistryServer): RegistryEntry {
  const name = (server.name.split('/').pop() || '').replace(/[^\w-]+/g,'-');
  const source = server.repository?.url;
  const result: RegistryEntry = {name:server.name, description:server.description,
    source:source?.startsWith('https://') ? source : undefined};
  for (const remote of server.remotes ?? []) {
    if (remote.type !== 'streamable-http' || !remote.url.startsWith('https://') || /[{}]/.test(remote.url)) continue;
    if (remote.headers?.some(h => h.name.toLowerCase() === 'authorization'
      ? !!h.value && !/^Bearer\s+\{[^}]+\}$/i.test(h.value)
      : h.isRequired !== false)) continue;
    const connection = {name:/^[a-z]/i.test(name) ? name : 'mcp-' + name, url:remote.url,tools:[],roles:[]};
    if (validMcp(connection)) { result.connection = connection; break; }
  }
  return result;
}

@Component({selector:'sat-mcp-registry', standalone:true, imports:[FormsModule,ButtonModule,InputTextModule],
  template:`
    <label>Поиск в официальном реестре MCP
      <input pInputText [(ngModel)]="query" (ngModelChange)="clear()" (keydown.enter)="$event.preventDefault(); search()" placeholder="Название сервера" [disabled]="loading" />
    </label>
    <p-button label="Найти MCP" severity="secondary" size="small" [loading]="loading" [disabled]="loading || query.trim().length < 3" (onClick)="search()" />
    @if (message) { <p role="status">{{message}}</p> }
    @for (item of results; track item.name) {
      <article>
        <strong>{{item.name}}</strong><small>{{item.description}}</small>
        @if (item.connection; as server) {
          <button type="button" pButton [text]="true" size="small" (click)="pick.emit(server)">Выбрать сервер</button>
        } @else { <small>Требуется ручная настройка подключения.</small> }
        @if (item.source) { <a [href]="item.source" target="_blank" rel="noopener noreferrer">Репозиторий</a> }
      </article>
    }
    @if (cursor) { <p-button label="Ещё серверы" size="small" [text]="true" [disabled]="loading" (onClick)="search(cursor)" /> }
    <a href="https://registry.modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Открыть официальный реестр</a>`,
  styles:[`:host,label,article {display:grid;gap:.4rem} :host{gap:.6rem} article{border-top:1px solid var(--p-content-border-color);padding:.5rem 0;overflow-wrap:anywhere} button{justify-self:start}`]
})
export class McpRegistryComponent {
  @Output() pick = new EventEmitter<ProjectMcp>();
  query = '';
  loading = false;
  results: RegistryEntry[] = [];
  cursor = '';
  message = '';
  clear(): void { this.results = []; this.cursor = ''; this.message = ''; }
  async search(cursor = ''): Promise<void> {
    if (this.loading || this.query.trim().length < 3) return;
    if (!cursor) this.clear();
    this.loading = true;
    try {
      const params = new URLSearchParams({search:this.query.trim(),version:'latest',limit:'10'});
      if (cursor) params.set('cursor',cursor);
      const response = await fetch('https://registry.modelcontextprotocol.io/v0.1/servers?' + params,
        {credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const page: {servers:{server:RegistryServer}[];metadata?:{nextCursor?:string}} = await response.json();
      const results = new Map(this.results.map(item => [item.name,item]));
      for (const {server} of page.servers) results.set(server.name,entry(server));
      this.results = [...results.values()];
      this.cursor = page.metadata?.nextCursor ?? '';
      this.message = this.results.length ? '' : 'Серверы не найдены.';
    } catch { this.message = 'Не удалось загрузить реестр. Повторите поиск или введите подключение вручную.'; }
    finally { this.loading = false; }
  }
}
