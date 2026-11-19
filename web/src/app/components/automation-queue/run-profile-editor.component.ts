import {Component, Input, Output, EventEmitter, inject, DestroyRef} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {ButtonModule} from 'primeng/button';
import {SelectModule} from 'primeng/select';
import {InputTextModule} from 'primeng/inputtext';
import {MessageModule} from 'primeng/message';
import {finalize} from 'rxjs';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import type {AgentRun, AutomationSettings} from '../../../../../shared/automation/contracts';

@Component({selector:'sat-run-profile-editor',standalone:true,
  imports:[FormsModule,ButtonModule,SelectModule,InputTextModule,MessageModule],
  styles:[':host {display:block;margin-block:1rem} label {display:block;margin-block:0.5rem} input {width:100%}'],
  template:`
  @if (available) {
    <p-button label="Изменить агентов запуска" severity="secondary" size="small" (onClick)="open()" />
    @if (editing) {
      <p-message severity="info">Будущие этапы можно менять во время работы. Для смены текущего этапа сначала остановите запуск. Изменение сохраняет ветку, историю и потраченный бюджет; продолжение запускается отдельно.</p-message>
      <label>Этап <p-select ariaLabel="Этап для смены агента" [options]="stages" optionLabel="label" optionValue="value" [ngModel]="stage" (ngModelChange)="selectStage($event)" appendTo="body" [fluid]="true" /></label>
      <label>Профиль <p-select ariaLabel="Новый профиль агента" [options]="profiles" optionLabel="label" optionValue="value" [(ngModel)]="profileId" (ngModelChange)="selectProfile()" appendTo="body" [fluid]="true" /></label>
      <label>Модель <input pInputText aria-label="Модель нового агента" [(ngModel)]="model" /></label>
      <p-button label="Применить к этапу" [disabled]="busy || stage === null || !profileId || !model.trim()" (onClick)="save()" />
      <p-button label="Закрыть редактор" severity="secondary" [text]="true" (onClick)="editing=false" />
      @if (error) { <p-message severity="error">{{error}}</p-message> }
    }
  }`
})
export class RunProfileEditorComponent {
  @Input({required:true}) public run!:AgentRun;
  @Output() public readonly changed=new EventEmitter<void>();
  private readonly http=inject(HttpClient);
  private readonly destroyRef=inject(DestroyRef);
  public editing=false;public busy=false;public stage:number|null=null;public profileId='';public model='';public error='';
  private configured?:AutomationSettings;private expectedProfileId='';private editingRunId='';
  public get available() {return !this.run.cleanup && !this.run.feature && ['queued','running','failed','waiting','interrupted','cancelled'].includes(this.run.status);}
  public get stages() {return this.run.settings.pipeline.flatMap((id,index)=>{
    const agent=this.run.settings.agents.find(a=>a.id===id);
    return index>=this.run.stage && !(index===this.run.stage && this.run.status==='running') ? [{value:index,label:`${index+1}. ${agent?.role} · ${agent?.model}`}]:[];
  });}
  public get profiles() {const role=this.run.settings.agents.find(a=>a.id===this.run.settings.pipeline[this.stage ?? -1])?.role;
    return this.configured?.agents.filter(a=>a.role===role).map(a=>({value:a.id,label:`${a.runner} · ${a.model} · ${a.id}`})) ?? [];}
  public open() {this.editing=true;this.error='';this.stage=null;this.profileId='';this.editingRunId=this.run.id;
    const id=this.run.id;this.http.get<AutomationSettings>('/api/automation/settings').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({next:value=>{if(this.run.id===id)this.configured=value;},error:()=>this.error='Не удалось загрузить профили проекта.'});}
  public selectStage(stage:number) {this.stage=stage;this.expectedProfileId=this.run.settings.pipeline[stage];this.profileId='';this.model='';}
  public selectProfile() {this.model=this.configured?.agents.find(a=>a.id===this.profileId)?.model ?? '';}
  public save() {if(this.busy || this.run.id!==this.editingRunId)return;this.busy=true;this.error='';
    this.http.post(`/api/automation/runs/${this.run.id}/profile`,{stage:this.stage,profileId:this.profileId,model:this.model,expectedProfileId:this.expectedProfileId})
      .pipe(finalize(()=>this.busy=false),takeUntilDestroyed(this.destroyRef)).subscribe({next:()=>{this.editing=false;this.changed.emit();},error:e=>this.error=e.error?.error?.message ?? e.error?.message ?? 'Не удалось сменить профиль. Обновите запуск и проверьте его состояние.'});}
}
