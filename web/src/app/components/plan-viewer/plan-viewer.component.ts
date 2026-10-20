import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageModule } from 'primeng/message';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { PlanRevision, PlanSnapshot, TaskAttachment } from '../../models/tracker.models';
import { renderMarkdown } from '../../shared/markdown';
import { formatDateTime, formatBytes } from '../../shared/format';

interface VersionOption {
  readonly label: string;
  readonly value: number;
}

/** Просмотр плана задачи с переключением версий (PrimeNG SelectButton). */
@Component({
  selector: 'sat-plan-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, MessageModule, SelectButtonModule, TagModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-viewer.component.html',
  styleUrl: './plan-viewer.component.scss',
})
export class PlanViewerComponent {
  public readonly attachments = input<readonly TaskAttachment[]>([]);
  public readonly currentPlan = input<PlanSnapshot | null>(null);

  private readonly selectedVersion = signal<number | null>(null);

  public readonly revisions = computed<readonly PlanRevision[]>(() =>
    this.attachments()
      .filter((attachment) => attachment.kind === 'plan')
      .sort((a, b) => a.version - b.version)
      .map((attachment) => ({
        attachmentId: attachment.id,
        name: attachment.name,
        version: attachment.version,
        isCurrent: attachment.isCurrent,
        size: attachment.size,
        sourcePath: attachment.sourcePath,
        createdAt: attachment.createdAt,
      })),
  );

  public readonly versionOptions = computed<VersionOption[]>(() =>
    this.revisions().map((revision) => ({
      label: revision.isCurrent ? `v${revision.version} · текущая` : `v${revision.version}`,
      value: revision.version,
    })),
  );

  public readonly activeVersion = computed<number | null>(() => {
    const selected = this.selectedVersion();
    if (selected !== null) return selected;
    const current = this.currentPlan();
    return current?.version ?? this.revisions().at(-1)?.version ?? null;
  });

  public readonly activeContent = computed<string>(() => {
    const version = this.activeVersion();
    if (version === null) return '';
    const attachment = this.attachments().find((item) => item.kind === 'plan' && item.version === version);
    return attachment?.content ?? '';
  });

  public readonly activeAttachment = computed<TaskAttachment | null>(() => {
    const version = this.activeVersion();
    return this.attachments().find((item) => item.kind === 'plan' && item.version === version) ?? null;
  });

  public readonly renderedHtml = computed(() => renderMarkdown(this.activeContent()));
  public readonly hasPlan = computed(() => this.revisions().length > 0);

  public selectVersion(version: number): void {
    this.selectedVersion.set(version);
  }

  public readonly formatDateTime = formatDateTime;
  public readonly formatBytes = formatBytes;
}
