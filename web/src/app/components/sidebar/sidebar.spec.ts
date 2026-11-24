import '@angular/compiler';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { SidebarComponent } from './sidebar.component.js';
import { TrackerStore } from '../../services/tracker-store.service.js';
import { WorkspaceService } from '../../services/workspace.service.js';

test('SidebarComponent exposes navigation events and expansion state', () => {
  const injector = Injector.create({
    providers: [
      { provide: TrackerStore, useValue: {} },
      { provide: WorkspaceService, useValue: {} },
      { provide: HttpClient, useValue: { get: () => of({ enabled: false }) } },
    ],
  });

  try {
    const component = runInInjectionContext(injector, () => new SidebarComponent());
    assert.equal(component.activePage(), 'board');
    assert.equal(component.isExpanded(), true);
    assert.equal(component.authEnabled(), false);
    component.isExpanded.set(false);
    assert.equal(component.isExpanded(), false);

    const events: Record<string, boolean | string | null> = {};
    component.openQueue.subscribe(runId => { events.queue = runId; });
    component.openAutomation.subscribe(() => { events.settings = true; });
    component.showTags.subscribe(visible => { events.tags = visible; });
    component.showBackups.subscribe(visible => { events.backups = visible; });
    component.showInstructions.subscribe(visible => { events.instructions = visible; });

    component.onOpenQueue();
    component.onOpenAutomation();
    component.onShowTags();
    component.onShowBackups();
    component.onShowInstructions();

    assert.deepEqual(events, {
      queue: null, settings: true, tags: true, backups: true, instructions: true,
    });
  } finally {
    injector.destroy();
  }
});
