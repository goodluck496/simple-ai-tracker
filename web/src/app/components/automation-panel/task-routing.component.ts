import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PanelModule } from 'primeng/panel';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import type { AgentRun, AutomationSettings } from '../../../../../shared/automation/contracts';

@Component({ selector: 'sat-task-routing', standalone: true,
  imports: [FormsModule, PanelModule, MultiSelectModule, CheckboxModule, InputTextModule, TableModule, TagModule, MessageModule],
  styles: [':host { display:block; min-width:0 } label { display:block; margin-block:0.75rem 0.25rem } label[for="managed-browser"] { display:inline; margin-left:0.5rem } input { width:100%; box-sizing:border-box } p-panel { display:block; margin-bottom:1rem }'],
  template: `
  @if (hasRouter || run?.routing) {
    <p-panel header="Подготовка задачи и выбор моделей">
      @if (editable) {
        <p-message severity="info">Роутер сохраняет этапы и лимиты. Выберите профили, которыми разрешено заменять исполнителей той же роли. Пустой список сохраняет выбранные модели.</p-message>
        <label for="routing-profiles">Разрешённые профили моделей</label>
        <p-multiselect inputId="routing-profiles" [options]="profiles" optionLabel="label" optionValue="value"
          [(ngModel)]="settings.routingProfileIds" placeholder="Сохранить выбранные модели" appendTo="body" [style]="{width:'100%'}" />
      }
      @if (run?.routing; as routing) {
        <p-tag [value]="'Сложность: ' + routing.decision.complexity" />
        <p-tag [value]="'Риск: ' + routing.decision.risk" severity="warn" />
        <p-tag [value]="'Неопределённость: ' + routing.decision.uncertainty" severity="secondary" />
        <p>{{ routing.decision.reason }}</p>
        <p>{{ routing.decision.brief.goal }}</p>
        <p>{{ routing.decision.brief.scope }}</p>
        <p-table [value]="routing.decision.assignments">
          <ng-template #header><tr><th>Этап</th><th>Модель</th><th>Причина</th></tr></ng-template>
          <ng-template #body let-row><tr><td>{{ row.stage + 1 }}</td><td>{{ model(row.profileId) }}</td><td>{{ row.reason }}</td></tr></ng-template>
        </p-table>
        <p-table [value]="routing.decision.brief.criteria">
          <ng-template #header><tr><th>Критерий</th><th>Проверка</th><th>Результат</th></tr></ng-template>
          <ng-template #body let-row><tr><td>{{ row.id }}: {{ row.requirement }}</td><td>{{ row.method }}</td><td>{{ result(row.id) }}</td></tr></ng-template>
        </p-table>
        <p>Критериев: {{ routing.decision.brief.criteria.length }} · замен профилей: {{ routing.decision.assignments.length }} · подтверждено: {{ passed }} / {{ routing.decision.brief.criteria.length }}</p>
        <p-message severity="secondary">Результаты сценариев сообщает тестировщик; команды проверок worker выполняет независимо. Ручные проверки ожидают пользователя.</p-message>
      } @else { <p>Решение и критерии появятся после этапа роутера.</p> }
    </p-panel>
  }
  @if (editable && browserEditable) {
    <p-panel header="Браузерная проверка">
      <p-checkbox inputId="managed-browser" [binary]="true" [ngModel]="!!settings.browser" (ngModelChange)="toggleBrowser($event)" />
      <label for="managed-browser">Worker запускает тестовое приложение</label>
      @if (settings.browser; as browser) {
        <p-message severity="info">Команда запускается в worktree с выделенным PORT. Аргументы — JSON-массив; подстановка порта: {{ portToken }}. Подключите браузерный MCP для тестировщика в docs/agent-environment.json и настройте тестовые данные проекта.</p-message>
        <label>Команда <input pInputText [(ngModel)]="browser.command" placeholder="npm" /></label>
        <label>Аргументы <input pInputText [ngModel]="browserArgs" (ngModelChange)="setArgs($event)" /></label>
        @if (argsError) { <p-message severity="error">{{ argsError }}</p-message> }
        <label>Путь готовности <input pInputText [(ngModel)]="browser.readyPath" placeholder="/" /></label>
      }
    </p-panel>
  }`
})
export class TaskRoutingComponent {
  @Input({required:true}) public settings!: AutomationSettings;
  @Input() public run?: AgentRun;
  @Input() public editable = false;
  @Input() public browserEditable = true;
  public argsError = '';
  public readonly portToken = '{port}';
  public get hasRouter() { return this.settings.pipeline.some(id => this.settings.agents.find(a => a.id === id)?.role === 'router'); }
  public get profiles() { return this.settings.agents.filter(a => a.role !== 'router' && a.role !== 'doctor').map(a => ({label: a.role + ' · ' + a.model + ' · ' + a.id, value:a.id})); }
  public get browserArgs() { return JSON.stringify(this.settings.browser?.args ?? []); }
  public setArgs(text: string) {
    try { const args = JSON.parse(text); if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error();
      this.settings.browser!.args = args; this.argsError = ''; }
    catch { this.argsError = 'Нужен JSON-массив строк. Сохранены последние корректные аргументы.'; }
  }
  public toggleBrowser(enabled: boolean) { this.settings.browser = enabled ? {command:'npm',args:['run','dev','--','--port','{port}'],readyPath:'/'} : undefined; }
  public model(id: string) { return this.settings.agents.find(a => a.id === id)?.model ?? id; }
  public get passed() { return this.run?.acceptance?.sha === this.run?.commitSha ? this.run?.acceptance?.results.filter(r => r.status === 'passed').length ?? 0 : 0; }
  public result(id: string) {
    if (!this.run?.acceptance || this.run.acceptance.sha !== this.run.commitSha) return 'Не проверено для текущего коммита';
    const result = this.run.acceptance.results.find(r => r.id === id);
    return result ? ({passed:'Пройдено',failed:'Ошибка',manual:'Вручную'}[result.status] + ': ' + result.evidence) : 'Не проверено';
  }
}
