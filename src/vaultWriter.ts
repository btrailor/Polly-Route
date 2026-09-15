import fs from 'fs';
import path from 'path';

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

/**
 * Resolve the vault root.
 *
 * Order of precedence:
 * 1. POLLY_VAULT_ROOT environment variable
 * 2. A `vault/` sibling of the polly-router directory (workspace default)
 * 3. `$HOME/.openclaw/workspace/vault`
 */
export function resolveVaultRoot(): string {
  if (process.env.POLLY_VAULT_ROOT) return path.resolve(process.env.POLLY_VAULT_ROOT);
  // From dist/src/vaultWriter.js → polly-router/dist/src → polly-router → workspace
  const siblingVault = path.resolve(__dirname, '..', '..', 'vault');
  if (fs.existsSync(siblingVault)) return siblingVault;
  return path.join(process.env.HOME || '.', '.openclaw', 'workspace', 'vault');
}

export interface CaptureNote {
  filename: string;
  content: string;
}

/**
 * Write a captured note to vault/20-Active/captured/.
 *
 * Safe / non-fatal:
 * - If the vault directory is missing or unwritable, the write is skipped and logged.
 * - Duplicate filenames are disambiguated with an incrementing counter.
 */
export async function writeCapture(note: CaptureNote, vaultRoot?: string): Promise<string | null> {
  const root = vaultRoot ?? resolveVaultRoot();
  const capturedDir = path.join(root, '20-Active', 'captured');

  try {
    await fs.promises.mkdir(capturedDir, { recursive: true });
  } catch (e) {
    log('capture skipped: cannot create captured dir', { root, error: (e as Error).message });
    return null;
  }

  let filepath = path.join(capturedDir, note.filename);
  try {
    await fs.promises.access(path.dirname(filepath), fs.constants.W_OK);
  } catch {
    log('capture skipped: vault directory not writable', { root });
    return null;
  }

  // Disambiguate if a file with this name already exists.
  if (fs.existsSync(filepath)) {
    const ext = path.extname(note.filename);
    const base = path.basename(note.filename, ext);
    let counter = 1;
    let candidate = path.join(capturedDir, `${base}-${counter}${ext}`);
    while (fs.existsSync(candidate)) {
      counter += 1;
      candidate = path.join(capturedDir, `${base}-${counter}${ext}`);
    }
    filepath = candidate;
  }

  try {
    await fs.promises.writeFile(filepath, note.content, 'utf-8');
    log('capture written', { path: filepath });
    return filepath;
  } catch (e) {
    log('capture failed', { path: filepath, error: (e as Error).message });
    return null;
  }
}
