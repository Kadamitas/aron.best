import { readFileSync } from 'node:fs';

export function withSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const values = { ...environment };
  for (const name of ['FRIEND_ACCESS_TOKEN', 'CONTROLLER_TOKEN', 'CURSEFORGE_API_KEY', 'CURSEFORGE_UPLOAD_TOKEN']) {
    const file = values[`${name}_FILE`];
    if (!file) continue;
    if (values[name]) throw new Error(`Configure ${name} or ${name}_FILE, not both.`);
    const contents = readFileSync(file, 'utf8').trim();
    if (!contents && ['CURSEFORGE_API_KEY', 'CURSEFORGE_UPLOAD_TOKEN'].includes(name)) { delete values[name]; continue; }
    if (!contents || contents.length > 1024) throw new Error(`The ${name} secret file is empty or too large.`);
    values[name] = contents;
  }
  return values;
}
