import { ChangeDetectionStrategy, Component, inject, model, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { TrackerStore } from '../../services/tracker-store.service';
import { WorkspaceSelectorComponent } from '../workspace-selector/workspace-selector.component';
import { WorkspaceService } from '../../services/workspace.service';

@Component({
  selector: 'sat-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    TooltipModule,
    DialogModule,
    WorkspaceSelectorComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  public readonly store = inject(TrackerStore);
  public readonly ws = inject(WorkspaceService);

  public readonly isExpanded = model<boolean>(true);
  public readonly showWorkspaceDialog = signal(false);

  public readonly openQueue = output<string | null>();
  public readonly openAutomation = output<void>();
  public readonly openBatchAutomation = output<void>();
  public readonly showTags = output<boolean>();
  public readonly showBackups = output<boolean>();
  public readonly showInstructions = output<boolean>();

  public onOpenQueue(): void {
    this.openQueue.emit(null);
  }

  public onOpenAutomation(): void {
    this.openAutomation.emit();
  }

  public onOpenBatchAutomation(): void {
    this.openBatchAutomation.emit();
  }

  public onShowTags(): void {
    this.showTags.emit(true);
  }

  public onShowBackups(): void {
    this.showBackups.emit(true);
  }

  public onShowInstructions(): void {
    this.showInstructions.emit(true);
  }
}