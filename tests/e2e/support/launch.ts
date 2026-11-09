import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** Isolated userData directory (logs live in `<userDataDir>/logs`). */
  readonly userDataDir: string;
  close(): Promise<void>;
  /** Parsed JSON-lines entries of the app's log file. */
  readLog(): Record<string, unknown>[];
}

export interface LaunchOptions {
  readonly faultInjection?: boolean;
  /** Fixed world seed (`FREEINDUSTRY_WORLD_SEED`); random when omitted. */
  readonly seed?: number;
  /** Turn on the factory scene's read-only measurement probe (`FREEINDUSTRY_SCENE_PROBE`). */
  readonly sceneProbe?: boolean;
  /** Reuse this userData directory (saves survive between launches); a new temporary one when omitted. */
  readonly userDataDir?: string;
}

/**
 * Launch the built app the same way `electron .` would (via package.json
 * "main"), with its own temporary userData directory so tests never touch
 * the developer's real profile or logs.
 *
 * VS Code (and other Electron-based hosts) export ELECTRON_RUN_AS_NODE=1 to
 * their terminals, which would make electron.exe behave as plain Node, so it
 * is stripped from the environment.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'freeindustry-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value;
    }
  }
  env['FREEINDUSTRY_USER_DATA_DIR'] = userDataDir;
  if (options.seed === undefined) {
    delete env['FREEINDUSTRY_WORLD_SEED'];
  } else {
    env['FREEINDUSTRY_WORLD_SEED'] = String(options.seed);
  }
  if (options.sceneProbe) {
    env['FREEINDUSTRY_SCENE_PROBE'] = '1';
  } else {
    delete env['FREEINDUSTRY_SCENE_PROBE'];
  }
  if (options.faultInjection) {
    env['FREEINDUSTRY_FAULT_INJECTION'] = '1';
  } else {
    delete env['FREEINDUSTRY_FAULT_INJECTION'];
  }

  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  let closed = false;
  return {
    app,
    page,
    userDataDir,
    async close() {
      if (!closed) {
        closed = true;
        await app.close();
      }
    },
    readLog() {
      const text = readFileSync(join(userDataDir, 'logs', 'freeindustry.log'), 'utf8');
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

export function removeUserData(launched: LaunchedApp): void {
  rmSync(launched.userDataDir, { recursive: true, force: true });
}
