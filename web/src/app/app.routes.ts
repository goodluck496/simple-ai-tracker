import type { Routes } from '@angular/router';

export const appRoutes: Routes = [
  { path: '', pathMatch: 'full', children: [] },
  { path: 'automation', pathMatch: 'full', redirectTo: 'automation/settings/team' },
  { path: 'automation/settings', pathMatch: 'full', redirectTo: 'automation/settings/team' },
  {
    path: 'automation/settings/:section',
    loadComponent: () => import('./components/automation-panel/automation-panel.component').then(module => module.AutomationPanelComponent),
  },
  { path: 'automation/runs', pathMatch: 'full', redirectTo: 'automation/runs/history' },
  {
    path: 'automation/runs/:view',
    loadComponent: () => import('./components/automation-queue/automation-queue.component').then(module => module.AutomationQueueComponent),
  },
  { path: '**', redirectTo: '' },
];
