import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { AppComponent } from './app/app.component';

fetch('/site-config.json').then(async response => {
  if (response.ok) {
    const configuration = await response.json() as { workshop?: boolean };
    document.documentElement.dataset['workshop'] = configuration.workshop === true ? 'true' : 'false';
  }
}).catch(() => undefined).then(() => bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
})).catch((error: unknown) => console.error('Application bootstrap failed', error));
