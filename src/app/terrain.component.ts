import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from './icon.component';

interface TerrainPoint {
  x: number;
  depth: number;
  elevation: number;
  brightness: number;
}

/** A deterministic surface. No images, random particles, or external animation loop. */
function createTerrain(): TerrainPoint[][] {
  return Array.from({ length: 100 }, (_, row) => {
    const depth = 1.4 + row * 0.095;
    return Array.from({ length: 170 }, (_, column) => {
      const x = (column - 85) * 0.072;
      const firstRidge = 2.2 * Math.exp(-((x - 1.1) ** 2 / 1.5 + (depth - 5.2) ** 2 / 8));
      const secondRidge = 1.15 * Math.exp(-((x + 1.8) ** 2 / 2.7 + (depth - 7.5) ** 2 / 7));
      const fold = Math.sin(x * 2.1 + depth * 0.55) * 0.16
        + Math.cos(x * 3.4 - depth * 0.9) * 0.07;
      const elevation = firstRidge + secondRidge + fold;
      const contour = Math.pow((Math.cos(elevation * 29) + 1) / 2, 7);
      return { x, depth, elevation, brightness: 0.34 + contour * 0.66 };
    });
  }).reverse();
}

@Component({
  selector: 'app-terrain',
  imports: [MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #surface aria-hidden="true"></canvas>
    @if (!reducedMotion()) {
      <button mat-button class="motion-control" (click)="toggleMotion()" [attr.aria-pressed]="paused()">
        <app-icon [name]="paused() ? 'play' : 'stop'"/>
        {{ paused() ? 'Play motion' : 'Pause motion' }}
      </button>
    }
  `,
  styles: [`
    :host { position: absolute; inset: 0; display: block; pointer-events: none; }
    canvas { display: block; width: 100%; height: 100%; }
    .motion-control {
      position: absolute;
      right: max(34px, calc((100% - 1120px) / 2));
      bottom: 24px;
      z-index: 3;
      pointer-events: auto;
      color: #929d96;
      background: #101212a6;
      font-size: 11px;
      font-weight: 400;
      border-radius: 4px;
      min-height: 36px;
      padding-inline: 12px;
    }
    .motion-control app-icon { width: 11px; height: 11px; margin: 0 7px 0 0; }
    @media (max-width: 600px) { .motion-control { right: 14px; bottom: 13px; } }
  `],
})
export class TerrainComponent implements AfterViewInit {
  private readonly surface = viewChild.required<ElementRef<HTMLCanvasElement>>('surface');
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly terrain = createTerrain();
  private readonly preference = matchMedia('(prefers-reduced-motion: reduce)');
  readonly reducedMotion = signal(this.preference.matches);
  readonly paused = signal(false);

  private context: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private frame = 0;
  private lastFrame = 0;
  private elapsed = 0;
  private visible = true;
  private destroyed = false;

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      const canvas = this.surface().nativeElement;
      this.context = canvas.getContext('2d', { alpha: true });
      if (!this.context) return;

      const resize = new ResizeObserver(() => this.resize());
      resize.observe(canvas);
      const visibility = new IntersectionObserver(([entry]) => {
        this.visible = entry?.isIntersecting ?? false;
        this.updatePlayback();
      });
      visibility.observe(canvas);

      const onVisibility = () => this.updatePlayback();
      const onPreference = (event: MediaQueryListEvent) => {
        this.reducedMotion.set(event.matches);
        this.updatePlayback();
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.preference.addEventListener('change', onPreference);
      this.resize();
      this.updatePlayback();

      this.destroyRef.onDestroy(() => {
        this.destroyed = true;
        cancelAnimationFrame(this.frame);
        resize.disconnect();
        visibility.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        this.preference.removeEventListener('change', onPreference);
      });
    });
  }

  toggleMotion(): void {
    this.paused.update(value => !value);
    this.zone.runOutsideAngular(() => this.updatePlayback());
  }

  private resize(): void {
    const canvas = this.surface().nativeElement;
    const rect = canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(this.width * ratio);
    canvas.height = Math.round(this.height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  private updatePlayback(): void {
    cancelAnimationFrame(this.frame);
    this.lastFrame = 0;
    if (this.destroyed || this.paused() || this.reducedMotion() || !this.visible || document.hidden) return;
    this.frame = requestAnimationFrame(time => this.tick(time));
  }

  private tick(time: number): void {
    // Twenty frames per second is sufficient for this slow surface movement.
    if (time - this.lastFrame >= 50) {
      this.elapsed += this.lastFrame ? Math.min(time - this.lastFrame, 100) / 1000 : 0;
      this.lastFrame = time;
      this.draw();
    }
    this.frame = requestAnimationFrame(next => this.tick(next));
  }

  private draw(): void {
    const context = this.context;
    if (!context || !this.width || !this.height) return;
    context.clearRect(0, 0, this.width, this.height);

    const center = this.width * (this.width < 650 ? 0.57 : 0.69);
    const horizontalScale = Math.max(this.width, 900) * 0.68;
    for (const row of this.terrain) {
      for (const point of row) {
        const perspective = point.depth + 2.8;
        const movement = Math.sin(point.x * 0.75 + point.depth * 0.42 + this.elapsed * 0.13) * 0.055;
        const x = center + point.x / perspective * horizontalScale;
        const y = this.height * 0.44 + (2.8 - point.elevation + movement) / perspective * this.height * 0.97;
        if (x < -2 || x > this.width + 2 || y < 0 || y > this.height) continue;
        const distanceFade = Math.min(1, 4.5 / perspective);
        const edgeFade = Math.min(1, (this.height - y) / (this.height * 0.12));
        const alpha = point.brightness * distanceFade * edgeFade * 0.82;
        const size = Math.max(0.85, 5.5 / perspective);
        context.fillStyle = `rgba(183, 195, 187, ${alpha})`;
        context.fillRect(x, y, size, size);
      }
    }
  }
}
