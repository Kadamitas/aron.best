import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      @switch (name()) {
        @case ('arrow-up-right') { <path d="M6 18 18 6M6 6h12v12"/> }
        @case ('arrow-right') { <path d="M4 12h16m-6-6 6 6-6 6"/> }
        @case ('arrow-down') { <path d="M12 4v16m-6-6 6 6 6-6"/> }
        @case ('plus') { <path d="M12 5v14M5 12h14"/> }
        @case ('close') { <path d="m6 6 12 12M6 18 18 6"/> }
        @case ('search') { <circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/> }
        @case ('check') { <path d="m5 12 4 4L19 6"/> }
        @case ('refresh') { <path d="M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.1 2M4.8 16A8 8 0 0 0 18 18"/> }
        @case ('copy') { <rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/> }
        @case ('cube') { <path d="m12 3 9 5v9l-9 5-9-5V8Zm0 9v10M3 8l9 4 9-4M7.5 5.5l9 5"/> }
        @case ('terminal') { <path d="m5 7 5 5-5 5m8 0h6"/> }
        @case ('folder') { <path d="M3 6h7l2 3h9v10H3Z"/> }
        @case ('play') { <path d="m7 4 14 8-14 8Z"/> }
        @case ('stop') { <rect x="6" y="6" width="12" height="12" rx="1"/> }
        @case ('download') { <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/> }
        @case ('server') { <rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M15 6.5h3M15 17.5h3"/> }
        @case ('clock') { <circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/> }
        @case ('shield') { <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6ZM8 11l3 3 5-6"/> }
        @case ('link') { <path d="m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 5l4-4a4 4 0 0 0 0-6m2-3 2-2a4 4 0 0 0-6-5L9 5a4 4 0 0 0 0 6"/> }
        @case ('mail') { <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/> }
        @case ('spark') { <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/> }
        @case ('backup') { <path d="M4 5h16v5H4ZM6 10v11h12V10m-8 5h4M7 2h10"/> }
        @case ('github') { <path d="M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-2.7c3.3-.4 6.7-1.6 6.7-7.3A5.7 5.7 0 0 0 19 4c.2-1.3.1-2.7-.5-4 0 0-1.3-.4-4.5 1.7a16 16 0 0 0-8 0C2.8-.4 1.5 0 1.5 0A7 7 0 0 0 1 4a5.7 5.7 0 0 0-1.7 4C-.7 13.7 2.7 14.9 6 15.3A3.5 3.5 0 0 0 5 18v4" transform="translate(2 1) scale(.9)"/> }
        @default { <circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/> }
      }
    </svg>
  `,
  styles: [`:host{display:inline-flex;width:1.25rem;height:1.25rem;flex-shrink:0;vertical-align:middle}svg{width:100%;height:100%}`],
})
export class IconComponent {
  readonly name = input('arrow-right');
}
