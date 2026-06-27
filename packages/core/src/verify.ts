import { sha256 } from './hashing.js';
import { extractRegion } from './hookRegion.js';
import { canonicalJson, findOwnedNode } from './hookJson.js';
import { installSkill, type InstallOptions } from './install.js';
import type { InstallManifest, ManagedHookEdit } from './model.js';
import type { FsPort } from './ports.js';

/** Per-file or per-edit verification status. */
export type VerifyStatus = 'ok' | 'modified' | 'missing' | 'extraneous';

/** Verification result for one managed file. */
export interface FileVerification {
  readonly relPath: string;
  readonly status: VerifyStatus;
}

/** Verification result for one managed hook edit. */
export interface HookEditVerification {
  readonly status: VerifyStatus;
  readonly edit: ManagedHookEdit;
}

/** Full verification report for an installed skill. */
export interface VerifyReport {
  /** True only when every file and hook edit is `ok`. */
  readonly ok: boolean;
  readonly files: readonly FileVerification[];
  readonly hookEdits: readonly HookEditVerification[];
}

/** Top-level directory segment of a relative path. */
function topDir(rel: string): string {
  const idx = rel.indexOf('/');
  return idx === -1 ? rel : rel.slice(0, idx);
}

/** Recursively list files under a directory relative to `root`. */
async function listFilesRec(fs: FsPort, root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const abs = `${root}/${rel}`;
  if (!(await fs.exists(abs))) return out;
  for (const entry of await fs.list(abs)) {
    const childRel = `${rel}/${entry}`;
    const stat = await fs.stat(`${root}/${childRel}`);
    if (stat?.isDirectory) {
      out.push(...(await listFilesRec(fs, root, childRel)));
    } else if (stat?.isFile) {
      out.push(childRel);
    }
  }
  return out;
}

async function verifyHookEdit(
  fs: FsPort,
  edit: Exclude<ManagedHookEdit, { kind: 'file' }>,
): Promise<VerifyStatus> {
  if (edit.kind === 'delimited') {
    if (!(await fs.exists(edit.file))) return 'missing';
    const block = extractRegion(await fs.readFile(edit.file), edit.delimiterId);
    if (block === undefined) return 'missing';
    return sha256(block) === edit.sha256 ? 'ok' : 'modified';
  }
  // json strategy: extract the owned node and compare its canonical hash.
  if (!(await fs.exists(edit.file))) return 'missing';
  const node = findOwnedNode(await fs.readFile(edit.file), edit.markerId);
  if (node === undefined) return 'missing';
  return sha256(canonicalJson(node)) === edit.sha256 ? 'ok' : 'modified';
}

/**
 * Recompute hashes for every managed file and hook edit and compare them to the
 * recorded manifest. Read-only. Reports `ok`, `modified`, `missing` per file and
 * hook edit, plus `extraneous` for unrecorded files in a managed directory.
 */
export async function verifyInstall(fs: FsPort, manifest: InstallManifest): Promise<VerifyReport> {
  const destRoot = manifest.destinationRoot;
  const files: FileVerification[] = [];

  // File-kind hook edits are verified together with body files.
  const fileEdits = manifest.hookEdits.filter(
    (e): e is Extract<ManagedHookEdit, { kind: 'file' }> => e.kind === 'file',
  );
  const recorded = new Map<string, string>();
  for (const f of manifest.files) recorded.set(f.relPath, f.sha256);
  for (const e of fileEdits) recorded.set(e.relPath, e.sha256);

  for (const [relPath, expected] of recorded) {
    const abs = `${destRoot}/${relPath}`;
    if (!(await fs.exists(abs))) {
      files.push({ relPath, status: 'missing' });
      continue;
    }
    const actual = sha256(await fs.readFile(abs));
    files.push({ relPath, status: actual === expected ? 'ok' : 'modified' });
  }

  // Detect extraneous files in each managed top-level directory.
  const managedDirs = new Set([...recorded.keys()].map(topDir));
  for (const dir of managedDirs) {
    const present = await listFilesRec(fs, destRoot, dir);
    for (const rel of present) {
      if (!recorded.has(rel)) {
        files.push({ relPath: rel, status: 'extraneous' });
      }
    }
  }

  const hookEdits: HookEditVerification[] = [];
  for (const edit of manifest.hookEdits) {
    if (edit.kind === 'file') continue; // handled as a file above
    hookEdits.push({ edit, status: await verifyHookEdit(fs, edit) });
  }

  const ok = files.every((f) => f.status === 'ok') && hookEdits.every((h) => h.status === 'ok');
  return { ok, files, hookEdits };
}

/** Options for {@link repairInstall} (an install plus the prior manifest). */
export interface RepairOptions extends InstallOptions {
  readonly manifest: InstallManifest;
}

/**
 * Repair a drifted install by reinstalling the skill to its recorded state.
 * Hooks are reapplied only when the caller passes `allowHooks` (re-consent).
 * Mutating and always explicit.
 */
export async function repairInstall(opts: RepairOptions): Promise<InstallManifest> {
  // Reinstalling overwrites modified files and recreates missing ones. The
  // returned manifest reflects the freshly written state.
  return installSkill(opts);
}
