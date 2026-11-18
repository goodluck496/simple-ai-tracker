import { TaskRoutingComponent } from './task-routing.component';
import { afterNextRender, Component, ElementRef, EventEmitter, Injector, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle, CdkDragPreview, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { PanelModule } from 'primeng/panel';
import { SelectModule } from 'primeng/select';
import { StepperModule } from 'primeng/stepper';
import { AgentRole, WRITABLE_AGENT_ROLES,
  type AgentProfile, type AgentRun, type AutomationSettings, type PipelineRoute } from '../../../../../shared/automation/contracts';
import { PipelinePolicy } from '../../../../../shared/automation/pipeline-policy';
import { ROLE_OPTIONS } from '../../../../../shared/automation/presets';
import { DEFAULT_ROLE_INSTRUCTIONS } from '../../../../../shared/automation/team-profiles';

@Component({
  selector: 'sat-pipeline-flow',
  standalone: true,
  imports: [TaskRoutingComponent, FormsModule, ButtonModule, InputNumberModule, PanelModule, SelectModule, StepperModule, CdkDrag, CdkDragHandle, CdkDragPreview, CdkDropList],
  templateUrl: './pipeline-flow.component.html',
  styleUrl: './pipeline-flow.component.scss',
})
export class PipelineFlowComponent {
  public constructor(private readonly host: ElementRef<HTMLElement>, private readonly injector: Injector) {}
  @Input({ required: true }) public settings!: AutomationSettings;
  @Input() public run?: AgentRun;
  @Input() public editable = false;
  @Input() public browserEditable = true;
  @Output() public readonly reorder = new EventEmitter<{ from: number; to: number }>();
  @Output() public readonly includeAgent = new EventEmitter<string>();
  @Output() public readonly createAgent = new EventEmitter<AgentRole>();
  @Output() public readonly excludeAgent = new EventEmitter<string>();

  public selected = -1;
  public adding = false;
  public stageChoice = '';
  public moveError = '';
  public readonly next = '@next';
  public readonly review = '@review';
  public readonly defaultRoute = '@default';
  public readonly exhaustionOptions = [{ label: 'Остановить запуск', value: 'stop' }, { label: 'Спросить пользователя и ждать', value: 'ask' }];
  public readonly visualRole = AgentRole.VisualValidator;
  public readonly criteria: Record<AgentRole, string> = {
    router: 'Оценивает сложность и риск, готовит критерии и выбирает разрешённые модели.',
    analyst: 'Изучает требования и готовит план.',
    developer: 'Реализует план и добавляет тесты.',
    designer: 'Реализует интерфейс по плану и референсам.',
    tester: 'Проверяет сборку, регрессии и пользовательские сценарии по требованиям задачи.',
    reviewer: 'Проверяет diff, архитектуру, покрытие тестами и соответствие плану.',
    'visual-validator': 'Проверяет визуальные требования по доступным скриншотам или по текущим компонентам, шаблонам и стилям.',
    doctor: 'Диагностирует сбои по журналу и состоянию рабочей копии.',
  };

  public get stages() {
    return this.settings.pipeline.map((id, index) => {
      const agent = this.settings.agents.find(profile => profile.id === id);
      return {
        id, index, agent, key: this.settings.pipeline.indexOf(id) === index ? id : `${id}:${index}`,
        label: agent ? this.roleLabel(agent.role) : id,
        checks: PipelinePolicy.checkAt(this.settings, index) ? this.settings.checks : [],
        gate: PipelinePolicy.isGate(this.settings, index),
        writer: !!agent && WRITABLE_AGENT_ROLES.includes(agent.role),
        route: PipelinePolicy.route(this.settings, index),
        calls: this.run?.usageAttempts?.filter(attempt => attempt.stage === index && attempt.kind !== 'resolver').length ?? 0,
        returns: this.run?.routeRetries?.[index] ?? 0,
        child: this.run?.feature?.children.find(item => item.developerStage === index || item.reviewerStage === index),
      };
    });
  }

  public get path(): number[] {
    return PipelinePolicy.executionPath(this.settings);
  }

  public get problem() { return PipelinePolicy.routeProblem(this.settings) ?? PipelinePolicy.routerProblem(this.settings); }
  public get stageOptions() {
    const existing = this.settings.agents.filter(agent => !this.settings.pipeline.includes(agent.id)).map(agent => ({
      label: `${this.roleLabel(agent.role)} · ${agent.model || 'модель не выбрана'}`, value: `profile:${agent.id}`,
    }));
    return [
      ...(existing.length ? [{ label: 'Агенты команды вне маршрута', items: existing }] : []),
      { label: 'Создать нового агента', items: ROLE_OPTIONS.map(role => ({ label: this.roleLabel(role.value), value: `role:${role.value}` })) },
    ];
  }
  public roleLabel(role: AgentRole): string { return ROLE_OPTIONS.find(option => option.value === role)?.label.split(' — ')[0] ?? role; }

  public addStage(): void {
    if (!this.stageChoice) return;
    const [kind, id] = this.stageChoice.split(':');
    const previous = new Set(this.settings.pipeline);
    if (kind === 'profile') this.includeAgent.emit(id);
    else this.createAgent.emit(id as AgentRole);
    this.selected = this.settings.pipeline.findIndex(stage => !previous.has(stage));
    this.moveError = '';
    this.stageChoice = '';
    this.adding = false;
    afterNextRender(() => {
      const row = this.host.nativeElement.querySelector<HTMLButtonElement>('.route-step[data-p-active="true"] .p-step-header');
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }

  public removeStage(id: string): void {
    this.excludeAgent.emit(id);
    this.selected = -1;
    this.moveError = '';
  }

  public passStage(index: number): number { return PipelinePolicy.passStage(this.settings, index); }
  public get positionOptions() {
    return this.settings.pipeline.map((_, index) => ({ label: String(index + 1), value: index }));
  }

  public get retryOptions() {
    return [
      { label: 'По общим правилам конвейера', value: this.defaultRoute },
      ...this.stages.filter(node => PipelinePolicy.canRetryFrom(this.settings, this.selected, node.index))
        .map(node => ({ label: `Вернуть на этап ${node.index + 1} · ${node.label}`, value: node.id })),
    ];
  }

  public get passOptions() {
    return [
      { label: 'Следующий этап по порядку', value: this.next },
      ...this.stages.filter(node => PipelinePolicy.canPassTo(this.settings, this.selected, node.index))
        .map(node => ({ label: `${node.index + 1}. ${node.label}`, value: node.id })),
      ...(PipelinePolicy.canPassTo(this.settings, this.selected, this.settings.pipeline.length) ? [{ label: 'Ручная приёмка', value: this.review }] : []),
    ];
  }

  public defaultRetry(stage: number, writer: boolean): number {
    return PipelinePolicy.revisionStage(this.settings, stage, writer, this.run?.feature);
  }

  public instructions(profile: AgentProfile): string {
    return profile.instructions.trim() || DEFAULT_ROLE_INSTRUCTIONS[profile.role];
  }

  public drop(event: CdkDragDrop<unknown>): void {
    if (event.isPointerOverContainer) this.move(event.previousIndex, event.currentIndex);
  }

  public move(from: number, to: number): boolean {
    this.moveError = '';
    if (!this.editable || from === to || from < 0 || to < 0 || to >= this.settings.pipeline.length) return false;
    try { PipelinePolicy.reorder(this.settings, from, to); }
    catch (error) {
      this.moveError = `Порядок не изменён. ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
    this.reorder.emit({ from, to });
    if (this.selected === from) this.selected = to;
    else if (from < this.selected && this.selected <= to) this.selected--;
    else if (to <= this.selected && this.selected < from) this.selected++;
    return true;
  }

  public setPass(choice: string): void {
    this.setRoute({ passTo: choice === this.next ? undefined : choice === this.review ? null : choice });
  }

  public setRetry(target: string): void {
    const retry = PipelinePolicy.route(this.settings, this.selected)?.retry;
    this.setRoute({ retry: target !== this.defaultRoute ? { to: target, limit: retry?.limit ?? this.settings.maxRevisions, exhausted: retry?.exhausted ?? 'stop' } : undefined });
  }

  public setLimit(limit: number | null): void {
    const retry = PipelinePolicy.route(this.settings, this.selected)?.retry;
    if (retry && limit !== null) this.setRoute({ retry: { ...retry, limit } });
  }

  public setExhaustion(exhausted: 'stop' | 'ask'): void {
    const retry = PipelinePolicy.route(this.settings, this.selected)?.retry;
    if (retry) this.setRoute({ retry: { ...retry, exhausted } });
  }

  public resetRoute(): void {
    this.setRoute({ passTo: undefined, retry: undefined });
  }

  private setRoute(update: Partial<PipelineRoute>): void {
    this.moveError = '';
    const from = this.settings.pipeline[this.selected];
    const route = { ...PipelinePolicy.route(this.settings, this.selected), ...update, from };
    const others = (this.settings.pipelineRoutes ?? []).filter(item => item.from !== from);
    this.settings.pipelineRoutes = route.passTo === undefined && !route.retry ? others : [...others, route];
  }
}
