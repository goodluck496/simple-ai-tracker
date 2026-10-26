import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { workspaceInterceptor } from './app/services/workspace.interceptor';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideZoneChangeDetection } from '@angular/core';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(withInterceptors([workspaceInterceptor])),
    provideAnimationsAsync(),
    // Тема PrimeNG: тёмная, активируется классом .p-dark на <html> (см. index.html).
    providePrimeNG({
      theme: {
        preset: Aura,
        options: {
          darkModeSelector: '.p-dark',
          cssLayer: false,
        },
      },
      ripple: true,
    }),
  ],
}).catch((error) => console.error(error));
