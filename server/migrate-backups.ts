import { readControllerConfiguration } from './controller.js';
import { migrateBackups } from './backup-maintenance.js';

if (process.argv.slice(2).join(' ') !== '--controller-stopped') throw new Error('Stop the controller container first, then pass --controller-stopped. This maintenance command verifies and compacts existing backups without changing server worlds.');
const configuration = readControllerConfiguration();
if (configuration.CONTAINER_SANDBOX !== 'true') throw new Error('Backup migration must run in the hardened Minecraft container.');
await migrateBackups(configuration.RUNTIME_DIRECTORY);
process.stdout.write('Existing backups were verified and migrated to shared checksum storage.\n');
