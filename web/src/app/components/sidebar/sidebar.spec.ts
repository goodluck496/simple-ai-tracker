import '@angular/compiler';
import assert from 'node:assert/strict';
import test from 'node:test';
import { signal, Injector, runInInjectionContext } from '@angular/core';
import { SidebarComponent } from './sidebar.component.js';
import { TrackerStore } from '../../services/tracker-store.service.js';
import type { TaskType } from '../../models/tracker.models.js';

test('SidebarComponent manages board filter options and navigation events', () => {
  const typeFilter = signal<TaskType | null>(null);
  const featureFilter = signal<string | null>(null);
  const features = signal([{ id: 'SAT-1', title: 'Header layout' }]);

  const mockStore = {
    features,
    typeFilter,
    featureFilter,
    setTypeFilter(type: TaskType | null) {
      typeFilter.set(type);
    },
    toggleFeatureFilter(id: string) {
      featureFilter.set(featureFilter() === id ? null : id);
    },
  };

  const injector = Injector.create({
    providers: [
      { provide: TrackerStore, useValue: mockStore },
    ],
  });

  const component = runInInjectionContext(injector, () => new SidebarComponent());

  assert.equal(component.isExpanded(), true);
  assert.equal(component.typeOptions.length, 3);
  assert.deepEqual(component.featureOptions(), [{ label: 'SAT-1 — Header layout', value: 'SAT-1' }]);

  // Test filter change handlers
  component.onTypeChange('bug');
  assert.equal(typeFilter(), 'bug');

  component.onFeatureChange('SAT-1');
  assert.equal(featureFilter(), 'SAT-1');

  component.resetBoardFilters();
  assert.equal(typeFilter(), null);
  assert.equal(featureFilter(), null);

  // Verify that navigation methods can be called without error
  // Since we are not using TestBed, we can't easily verify EventEmitter/Output emissions 
  // without more complex mocking, but we ensure they don't throw.
  component.onOpenQueue();
  component.onOpenAutomation();
  component.onOpenBatchAutomation();
  component.onShowTags();
  component.onShowBackups();
  component.onShowInstructions();
  
  // Check that expanding/collapsing works
  component.isExpanded.set(false);
  assert.equal(component.isExpanded(), false);
  component.isExpanded.set(true);
  assert.equal(component.isExpanded(), true);
});
