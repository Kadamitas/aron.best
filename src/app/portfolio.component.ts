import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from './icon.component';
import { TerrainComponent } from './terrain.component';

@Component({
  selector: 'app-portfolio',
  imports: [MatButtonModule, IconComponent, TerrainComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './portfolio.component.html',
  styleUrl: './portfolio.component.scss',
})
export class PortfolioComponent {
  readonly year = new Date().getFullYear();
  readonly projects = [
    {
      id: 'fabricated-backpacks',
      name: 'Fabricated Backpacks',
      description: 'A Minecraft mod with upgradeable backpacks, portable workstations, automation, and a recipe browser.',
      technology: 'Java · Fabric',
      url: 'https://github.com/Kadamitas/fabricated-backpacks',
    },
    {
      id: 'warlockery',
      name: 'Warlockery',
      description: 'A Minecraft mod centered on ritual magic, brewing, supernatural progression, and magical creatures.',
      technology: 'Java · Forge',
      url: 'https://github.com/Kadamitas/Warlockery',
    },
    {
      id: 'file-organizer',
      name: 'PowerShell File Organizer',
      description: 'A script that sorts files into folders by month and year.',
      technology: 'PowerShell',
      url: 'https://github.com/Kadamitas/PSHFileFolderOrganizer',
    },
  ] as const;
}
