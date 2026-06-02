import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const generatedDir = resolve(repoRoot, 'packages/voice-db/generated/client');
const generatedIndex = resolve(generatedDir, 'index.js');
const generatedPackageJson = resolve(generatedDir, 'package.json');

function generatedClientLooksValid() {
  if (!existsSync(generatedIndex) || !existsSync(generatedPackageJson)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(generatedPackageJson, 'utf8'));
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function runGenerate() {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', '@bookstore-voice-agents/voice-db', 'run', 'generate'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        VOICE_AGENT_DATABASE_URL:
          process.env.VOICE_AGENT_DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/voice_agent',
      },
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!generatedClientLooksValid()) {
  console.log('[ensure-voice-db-client] Missing or invalid generated client. Regenerating...');
  runGenerate();
}
