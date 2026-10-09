import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maxInputBytes = 2 * 1024 * 1024;

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rejectSymlinkPath(target: string): Promise<void> {
  let current = path.parse(target).root;
  for (const component of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Restricted path must not contain symlinks');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// Existing acquire callers retain their storage and error contracts. Offline observation
// callers first validate all declared namespaces with offlinePaths, then use private reads.
export async function restrictedRoot(outputRoot: string, protectedRoot: string): Promise<string> {
  const resolved = path.resolve(outputRoot);
  const protectedResolved = path.resolve(protectedRoot);
  if (contains(repositoryRoot, resolved) || contains(protectedResolved, resolved) ||
      contains(resolved, repositoryRoot) || contains(resolved, protectedResolved)) {
    throw new Error('Restricted output must be separate from repository and provider state');
  }
  await rejectSymlinkPath(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (contains(repositoryRoot, canonical) || contains(protectedResolved, canonical) ||
      contains(canonical, repositoryRoot) || contains(canonical, protectedResolved)) {
    throw new Error('Restricted output resolves into repository or provider state');
  }
  const info = await stat(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Restricted output root must be operator-owned and mode 0700');
  }
  return canonical;
}

export async function readIsolatedJson(inputPath: string, protectedRoot: string): Promise<{ bytes: Buffer; value: unknown }> {
  const resolved = path.resolve(inputPath);
  const protectedResolved = path.resolve(protectedRoot);
  if (contains(protectedResolved, resolved) || contains(repositoryRoot, resolved)) {
    throw new Error('Input JSON must not be read from provider state or repository');
  }
  await rejectSymlinkPath(resolved);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('Input JSON must be a regular file');
  const canonical = await realpath(resolved);
  if (contains(protectedResolved, canonical) || contains(repositoryRoot, canonical)) {
    throw new Error('Input JSON resolves into provider state or repository');
  }
  const bytes = await readFile(canonical);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Input must be valid JSON');
  }
  return { bytes, value };
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value) || path.resolve(value) !== value) {
    throw new Error('Invalid canonical offline storage path');
  }
  return value;
}

function separate(value: string, protectedRoot: string): void {
  for (const root of [repositoryRoot, protectedRoot]) {
    if (contains(root, value) || contains(value, root)) throw new Error('Unsafe offline storage boundary');
  }
}

function privateOwned(info: Stats): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

async function ancestors(value: string, allowMissing: boolean): Promise<void> {
  let current = path.parse(value).root;
  const parts = path.relative(current, value).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new Error('Unsafe offline storage path: symlink or non-directory ancestor');
      }
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export interface WereadOfflinePaths {
  inputDirs: string[];
  inputFiles: string[];
  outputRoot: string;
  protectedRoot: string;
}

/** Exclude every declared path lexically before any filesystem inspection.
 * The protected namespace must be operator-supplied canonical Linux storage;
 * it is deliberately never inspected or resolved (mount aliases are not detectable).
 */
export async function offlinePaths(inputDirs: string[], inputFiles: string[], outputRoot: string, protectedRoot: string): Promise<WereadOfflinePaths> {
  const protectedPath = absolute(protectedRoot);
  const directories = inputDirs.map(absolute);
  const files = inputFiles.map(absolute);
  const output = absolute(outputRoot);
  const inputs = [...directories, ...files];
  for (const value of [...inputs, output]) separate(value, protectedPath);
  if (directories.some((directory) => path.basename(directory).startsWith('.partial'))) {
    throw new Error('Incomplete acquisition run directory');
  }
  if (inputs.some((value) => contains(value, output) || contains(output, value))) {
    throw new Error('Offline input and output must be separate');
  }
  for (let index = 0; index < inputs.length; index++) {
    for (let other = index + 1; other < inputs.length; other++) {
      const left = inputs[index]!;
      const right = inputs[other]!;
      if (left === right || contains(left, right) || contains(right, left)) {
        throw new Error('Offline input namespaces must not overlap or repeat');
      }
    }
  }
  for (const directory of directories) {
    await privateDirectory(directory);
  }
  for (const file of files) {
    await privateDirectory(path.dirname(file));
    await ancestors(file, false);
    const info = await lstat(file);
    if (!info.isFile() || !privateOwned(info) || info.nlink !== 1 || info.size > maxInputBytes) {
      throw new Error('Unsafe private input file');
    }
  }
  await ancestors(output, true);
  try {
    await privateDirectory(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { inputDirs: directories, inputFiles: files, outputRoot: output, protectedRoot: protectedPath };
}

export async function privateDirectory(directory: string): Promise<void> {
  absolute(directory);
  separate(directory, repositoryRoot);
  await ancestors(directory, false);
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateOwned(info)) throw new Error('Unsafe private directory');
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && privateOwned(right) && right.nlink === 1 &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Bounded, nonblocking, nofollow reads; refuse hardlink aliases and changed files. */
export async function privateBytes(filename: string): Promise<Buffer> {
  absolute(filename);
  await privateDirectory(path.dirname(filename));
  const before = await lstat(filename);
  if (!before.isFile() || !privateOwned(before) || before.nlink !== 1 || before.size > maxInputBytes) {
    throw new Error('Unsafe private input file');
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!sameFile(before, info)) throw new Error('Changed private input file');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length !== info.size || !sameFile(info, await handle.stat()) || !sameFile(info, await lstat(filename))) {
      throw new Error('Changed private input file');
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export function parseJsonBytes(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function privateJson(filename: string): Promise<unknown> {
  return parseJsonBytes(await privateBytes(filename));
}
