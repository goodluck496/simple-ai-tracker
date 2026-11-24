import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import type { AutomationSettings } from '../../../../../shared/automation/contracts';
import { validMcp, type ProjectMcp } from '../../../../../shared/automation/project-mcp';
import { MCP_PRESETS } from '../../../../../shared/automation/mcp-catalog';
import { McpRegistryComponent } from './mcp-registry.component';

@Component({ selector:'sat-project-mcp', standalone:true, imports:[FormsModule,ButtonModule,DialogModule,InputTextModule,MultiSelectModule,SelectModule,McpRegistryComponent],
  template:`
    <section aria-label="Подключения MCP">
      <header><h4>Подключения MCP</h4><p-button severity="secondary" size="small" label="Добавить MCP" (onClick)="open()" /></header>
      @for (server of settings.mcpServers; track server.name) {
        <div class="row"><strong>{{server.name}}</strong><span>{{ server.url ? 'HTTP' : 'stdio' }} · {{server.tools.length ? server.tools.length + ' инстр.' : 'Инструменты не выбраны'}}</span>
          <p-button icon="pi pi-pencil" [text]="true" [ariaLabel]="'Изменить MCP ' + server.name" (onClick)="open(server)" />
          <p-button icon="pi pi-times" [text]="true" [ariaLabel]="'Отключить MCP ' + server.name" (onClick)="disconnect(server.name)" />
        </div>
      }
      <p>Сохраните подключения в настройках проекта и назначьте их ролям в разделе «Команда агентов». Поддерживаются Codex CLI и Model API.</p>
    </section>
    <p-dialog header="Подключение MCP" [(visible)]="editing" [modal]="true" appendTo="body" [closable]="!checking" [closeOnEscape]="!checking" [style]="{width:'36rem',maxWidth:'95vw'}">
      <fieldset [disabled]="checking">
        @if (!original) {
          <div class="row">
            @for (preset of presets; track preset.server.name) {
              <p-button [label]="preset.label" severity="secondary" size="small" [disabled]="checking" (onClick)="usePreset(preset.server, preset.source)" />
            }
            <p-button label="Своя настройка" [text]="true" size="small" (onClick)="open()" />
          </div>
          @if (source) { <a [href]="source" target="_blank" rel="noopener noreferrer">Документация подключения</a> }
          <button type="button" pButton [text]="true" (click)="registryOpen=!registryOpen" [attr.aria-expanded]="registryOpen">Поиск по реестру MCP</button>
          @if (registryOpen) { <sat-mcp-registry (pick)="useRegistryServer($event)" /> }
        }
        <label>Имя MCP<input pInputText [(ngModel)]="name" placeholder="project-search" /></label>
        <label>Транспорт<p-select [(ngModel)]="transport" [options]="['stdio','HTTP']" ariaLabel="Транспорт MCP" appendTo="body" (onChange)="clearInventory()" /></label>
        @if (transport === 'stdio') {
          <label>Команда на воркере<input pInputText [(ngModel)]="command" (ngModelChange)="clearInventory()" placeholder="node" /></label>
          <label>Аргументы команды (массив JSON)<input pInputText [(ngModel)]="args" (ngModelChange)="clearInventory()" /></label>
          <label>Имена переменных окружения<input pInputText [(ngModel)]="envNames" (ngModelChange)="clearInventory()" placeholder="PROJECT_TOKEN" /></label>
        } @else {
          <label>URL сервера (Streamable HTTP)<input pInputText [(ngModel)]="url" (ngModelChange)="clearInventory()" placeholder="https://example.org/mcp" /></label>
          <label>Переменная воркера с bearer-токеном<input pInputText [(ngModel)]="tokenEnv" (ngModelChange)="clearInventory()" placeholder="Необязательно" /></label>
        }
        <p-button label="Получить инструменты с воркера" severity="secondary" [disabled]="!canDiscover || checking" [loading]="checking" (onClick)="discover()" />
        @if (!online) { <p>Воркер не подключён. Можно ввести имена инструментов вручную или добавить подключение и выбрать их позже.</p> }
        @else if (!canDiscover) { <p>Для запуска команды укажите папку проекта в разделе «Проект и проверки».</p> }
        @if (available.length) {
          <label>Разрешённые инструменты<p-multiSelect [options]="available" [ngModel]="selectedTools" (ngModelChange)="selectTools($event)" [filter]="true" appendTo="body" ariaLabel="Разрешённые инструменты MCP" /></label>
        } @else {
          <label>Разрешённые инструменты через запятую<input pInputText [(ngModel)]="tools" /></label>
        }
        @if (message) { <p role="status">{{message}}</p> }
        @if (!tools.trim() && !original?.roles?.length) { <small>Назначить сервер роли можно после выбора инструментов.</small> }
        <p-button [label]="!tools.trim() && !original ? 'Добавить без инструментов' : 'Применить подключение'" [disabled]="checking" (onClick)="apply()" />
      </fieldset>
    </p-dialog>`,
  styles:[`header,.row{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap} header{justify-content:space-between} h4,p{margin:.4rem 0} section>p,.row span{color:var(--p-text-muted-color)} fieldset,label{display:grid;gap:.35rem} fieldset{border:0;padding:0;gap:.8rem;min-width:0} input{width:100%}`]
})
export class ProjectMcpComponent {
  readonly presets = MCP_PRESETS;
  source = '';
  registryOpen = false;
  @Input({required:true}) settings!: AutomationSettings;
  @Input() online = false;
  @Input({required:true}) probe!: (server:ProjectMcp) => Promise<string[] | undefined>;
  editing = false;
  checking = false;
  original?: ProjectMcp;
  name = ''; transport = 'stdio'; url = ''; tokenEnv = ''; command = ''; args = '[]'; envNames = ''; tools = ''; message = '';
  available: string[] = [];
  selectedTools: string[] = [];
  get canDiscover(): boolean { return this.online && (this.transport === 'HTTP' || !!this.settings.repositoryPath.trim()); }
  useRegistryServer(server: ProjectMcp): void {
    this.usePreset(server);
    if (this.canDiscover) void this.discover();
  }
  clearInventory(): void {
    this.available = [];
    this.message = '';
  }
  selectTools(names: string[]): void {
    this.selectedTools = names;
    this.tools = names.join(', ');
  }
  open(server?: ProjectMcp): void {
    this.original = server;
    this.usePreset(server);
    this.editing = true;
  }
  usePreset(server?: ProjectMcp, source = ''): void {
    this.source = source;
    this.registryOpen = false;
    this.name = server?.name ?? ''; this.transport = server?.url ? 'HTTP' : 'stdio';
    this.url = server?.url ?? ''; this.tokenEnv = server?.url !== undefined ? server.bearerTokenEnvVar ?? '' : '';
    this.command = server?.command ?? ''; this.args = JSON.stringify(server?.command !== undefined ? server.args : []);
    this.envNames = server?.command !== undefined ? server.envVars.join(', ') : '';
    this.selectTools(server?.tools ?? []);
    this.available = []; this.message = '';
  }
  toolNames(): string[] { return this.tools.split(/[\s,]+/).filter(Boolean); }
  private value(): ProjectMcp {
    const common = {name:this.name.trim(),roles:this.original?.roles ?? [],tools:this.toolNames()};
    let args: unknown = [];
    if (this.transport === 'stdio') {
      try { args = JSON.parse(this.args); } catch { throw new Error('Аргументы должны быть массивом строк JSON.'); }
    }
    const server = this.transport === 'HTTP'
      ? {...common,url:this.url.trim(),...(this.tokenEnv.trim() ? {bearerTokenEnvVar:this.tokenEnv.trim()} : {})}
      : {...common,command:this.command.trim(),args,envVars:this.envNames.split(/[\s,]+/).filter(Boolean)};
    if (!validMcp(server)) throw new Error('Проверьте имя, адрес или команду, аргументы и имена переменных.');
    if (this.settings.mcpServers?.some(s => s !== this.original && s.name === server.name)) throw new Error('Это имя MCP уже используется.');
    return server;
  }
  async discover(): Promise<void> {
    this.message = ''; this.checking = true;
    try {
      const available = await this.probe({...this.value(),tools:[]});
      this.available = available ?? [];
      this.message = available?.length ? 'Выберите инструменты, которые будут доступны агенту.'
        : available ? 'Сервер вернул пустой список инструментов.' : 'Воркер не подтвердил подключение.';
      if (available) this.selectTools(this.toolNames().filter(name => available.includes(name)));
    } catch (e) { this.message = e instanceof Error ? e.message : String(e); }
    finally { this.checking = false; }
  }
  apply(): void {
    try {
      const server = this.value();
      if (!server.tools.length && server.roles?.length) throw new Error('Сервер назначен ролям. Выберите для них инструменты или снимите назначение в разделе «Команда агентов».');
      const current = this.settings.mcpServers ?? [];
      this.settings.mcpServers = this.original ? current.map(s => s === this.original ? server : s) : [...current,server];
      this.editing = false;
    } catch (e) { this.message = e instanceof Error ? e.message : String(e); }
  }
  disconnect(name:string): void { this.settings.mcpServers = this.settings.mcpServers?.filter(s => s.name !== name); }
}
