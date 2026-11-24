import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, computed, effect, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import * as Diff2Html from 'diff2html';
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui';
import { ColorSchemeType, type DiffFile } from 'diff2html/lib/types';

export interface DiffFileInfo {
  index: number;
  id: string;
  name: string;
  directory: string;
  basename: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  addedLines: number;
  deletedLines: number;
}

@Component({
  selector: 'sat-git-diff-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, TooltipModule, InputTextModule],
  templateUrl: './git-diff-viewer.component.html',
  styleUrl: './git-diff-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitDiffViewerComponent {
  @ViewChild('diffContainer', { static: false })
  public diffContainerRef?: ElementRef<HTMLDivElement>;

  public readonly diff = input<string>('');
  public readonly truncated = input<boolean>(false);

  public readonly outputFormat = signal<'line-by-line' | 'side-by-side'>('line-by-line');
  public readonly copied = signal<boolean>(false);
  public readonly allCollapsed = signal<boolean>(false);
  public readonly sidebarCollapsed = signal<boolean>(false);
  public readonly fileSearch = signal<string>('');
  public readonly activeFileIndex = signal<number>(0);

  public readonly parsedFiles = computed<DiffFile[]>(() => {
    const raw = this.diff()?.trim();
    if (!raw) return [];
    try {
      return Diff2Html.parse(raw);
    } catch {
      return [];
    }
  });

  public readonly fileList = computed<DiffFileInfo[]>(() => {
    const parsed = this.parsedFiles();
    return parsed.map((f, index) => {
      const name = f.newName || f.oldName || `file-${index}`;
      const lastSlash = name.lastIndexOf('/');
      const directory = lastSlash >= 0 ? name.slice(0, lastSlash + 1) : '';
      const basename = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;

      let status: 'added' | 'deleted' | 'renamed' | 'modified' = 'modified';
      if (f.oldName === '/dev/null' || f.oldName === 'dev/null' || (f.addedLines > 0 && f.deletedLines === 0 && !f.oldName)) {
        status = 'added';
      } else if (f.newName === '/dev/null' || f.newName === 'dev/null') {
        status = 'deleted';
      } else if (f.oldName && f.newName && f.oldName !== f.newName) {
        status = 'renamed';
      }

      return {
        index,
        id: `diff-file-${index}`,
        name,
        directory,
        basename,
        status,
        addedLines: f.addedLines,
        deletedLines: f.deletedLines,
      };
    });
  });

  public readonly filteredFiles = computed<DiffFileInfo[]>(() => {
    const query = this.fileSearch().trim().toLowerCase();
    const list = this.fileList();
    if (!query) return list;
    return list.filter(f => f.name.toLowerCase().includes(query));
  });

  public readonly stats = computed(() => {
    const files = this.parsedFiles();
    let added = 0;
    let deleted = 0;
    for (const f of files) {
      added += f.addedLines;
      deleted += f.deletedLines;
    }
    return {
      fileCount: files.length,
      added,
      deleted,
    };
  });

  public constructor() {
    effect(() => {
      const raw = this.diff();
      const format = this.outputFormat();
      if (!raw || !raw.trim()) return;

      queueMicrotask(() => this.renderDiff(raw, format));
    });
  }

  public setOutputFormat(format: 'line-by-line' | 'side-by-side'): void {
    this.outputFormat.set(format);
  }

  public toggleSidebar(): void {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
  }

  public selectFile(file: DiffFileInfo): void {
    this.activeFileIndex.set(file.index);
    const container = this.diffContainerRef?.nativeElement;
    if (!container) return;

    const target = container.querySelector<HTMLElement>(`#${file.id}`);
    if (target) {
      // Expand file if it was collapsed
      const content = target.querySelector<HTMLElement>('.d2h-files-diff, .d2h-file-diff');
      if (content && content.style.display === 'none') {
        content.style.display = '';
        const chevron = target.querySelector('.sat-diff-chevron');
        chevron?.classList.remove('collapsed');
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  public toggleCollapseAll(): void {
    const container = this.diffContainerRef?.nativeElement;
    if (!container) return;
    const collapse = !this.allCollapsed();
    this.allCollapsed.set(collapse);

    const fileWrappers = container.querySelectorAll('.d2h-file-wrapper');
    fileWrappers.forEach(wrapper => {
      const content = wrapper.querySelector('.d2h-files-diff, .d2h-file-diff');
      if (content instanceof HTMLElement) {
        content.style.display = collapse ? 'none' : '';
      }
      const chevron = wrapper.querySelector('.sat-diff-chevron');
      if (chevron instanceof HTMLElement) {
        chevron.classList.toggle('collapsed', collapse);
      }
    });
  }

  public copyDiff(): void {
    const text = this.diff();
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    }).catch(() => {});
  }

  private renderDiff(rawDiff: string, format: 'line-by-line' | 'side-by-side'): void {
    const container = this.diffContainerRef?.nativeElement;
    if (!container) return;

    try {
      const ui = new Diff2HtmlUI(container, rawDiff, {
        outputFormat: format,
        drawFileList: false, // We have our own persistent left sidebar!
        matching: 'lines',
        matchWordsThreshold: 0.25,
        diffStyle: 'word',
        colorScheme: ColorSchemeType.DARK,
        highlight: true,
        fileListToggle: false,
        fileListStartVisible: false,
        fileContentToggle: false,
        stickyFileHeaders: false, // Disabled to eliminate floating element bug
        synchronisedScroll: true,
      });
      ui.draw();
      this.allCollapsed.set(false);
      this.enhanceUi(container);
    } catch (err) {
      console.warn('diff2html render fallback:', err);
      container.innerHTML = `<pre class="diff-fallback"><code>${this.escapeHtml(rawDiff)}</code></pre>`;
    }
  }

  private enhanceUi(container: HTMLDivElement): void {
    this.attachContainerListeners(container);

    const wrappers = container.querySelectorAll<HTMLElement>('.d2h-file-wrapper');
    wrappers.forEach((wrapper, index) => {
      // Assign predictable ID matching our sidebar items
      wrapper.id = `diff-file-${index}`;

      const header = wrapper.querySelector<HTMLElement>('.d2h-file-header');
      if (header) {
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.setAttribute('title', 'Нажмите, чтобы свернуть/развернуть файл');

        const nameWrapper = header.querySelector<HTMLElement>('.d2h-file-name-wrapper');
        if (nameWrapper && !nameWrapper.querySelector('.sat-diff-chevron')) {
          const chevron = document.createElement('i');
          chevron.className = 'pi pi-chevron-down sat-diff-chevron';
          chevron.setAttribute('aria-hidden', 'true');
          nameWrapper.prepend(chevron);
        }
      }
    });
  }

  private attachContainerListeners(container: HTMLDivElement): void {
    if (container.dataset['satListenersAttached']) return;
    container.dataset['satListenersAttached'] = 'true';

    container.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Collapse/expand on header click
      const header = target.closest<HTMLElement>('.d2h-file-header');
      if (header) {
        const fileWrapper = header.closest<HTMLElement>('.d2h-file-wrapper');
        if (fileWrapper) {
          const content = fileWrapper.querySelector<HTMLElement>('.d2h-files-diff, .d2h-file-diff');
          const chevron = header.querySelector('.sat-diff-chevron');
          if (content) {
            const isCollapsed = content.style.display === 'none';
            content.style.display = isCollapsed ? '' : 'none';
            chevron?.classList.toggle('collapsed', !isCollapsed);
          }
        }
      }
    });

    container.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        const target = event.target as HTMLElement | null;
        const header = target?.closest<HTMLElement>('.d2h-file-header');
        if (header && target === header) {
          event.preventDefault();
          header.click();
        }
      }
    });
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
