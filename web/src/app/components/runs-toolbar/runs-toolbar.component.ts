import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { RunsHeaderService, type RunsView } from '../../services/runs-header.service';

@Component({
  selector: 'sat-runs-toolbar',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './runs-toolbar.component.html',
  styleUrl: './runs-toolbar.component.scss',
})
export class RunsToolbarComponent {
  public readonly runsHeader = inject(RunsHeaderService);

  public readonly views: { id: RunsView; label: string; icon: string }[] = [
    { id: 'queue', label: 'Рабочая очередь', icon: 'pi pi-list' },
    { id: 'history', label: 'История', icon: 'pi pi-history' },
    { id: 'metrics', label: 'Метрики', icon: 'pi pi-chart-line' },
  ];
}
