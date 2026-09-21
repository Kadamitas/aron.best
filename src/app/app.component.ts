import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PortfolioComponent } from './portfolio.component';
import { WorkshopComponent } from './workshop.component';

@Component({
  selector: 'app-root',
  imports: [PortfolioComponent, WorkshopComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (workshop) { @defer (on immediate) { <app-workshop/> } @placeholder { <p role="status">Loading workshop...</p> } } @else { <app-portfolio/> }`,
})
export class AppComponent {
  readonly workshop = location.hostname === 'mc.modpack.aron.best'
    || (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      && new URLSearchParams(location.search).get('workshop') === '1');

  constructor() {
    if (this.workshop) {
      document.title = 'The Workshop | Our Minecraft world';
      document.querySelector('meta[name="description"]')?.setAttribute('content', 'A shared workshop for our Minecraft modpack and server.');
      document.querySelector('link[rel="canonical"]')?.setAttribute('href', 'https://mc.modpack.aron.best/');
      const robots = document.createElement('meta');
      robots.name = 'robots';
      robots.content = 'noindex, nofollow';
      document.head.appendChild(robots);
    }
  }
}
