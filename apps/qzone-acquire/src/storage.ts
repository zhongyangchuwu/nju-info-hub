import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maxInputBytes = 2 * 1024 * 1024;

export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function restrictedRoot(outputRoot: string, protectedRoot: string): Promise<string> {
  if (!path.isAbsolute(outputRoot)) throw new Error('Restricted output root must be absolute');
  const resolved = path.resolve(outputRoot);
  if (contains(repositoryRoot, resolved) || contains(protectedRoot, resolved) ||
      contains(resolved, repositoryRoot) || contains(resolved, protectedRoot)) {
    throw new Error('Restricted output must be separate from the repository and protected platform storage');
  }
  // Inspect only output ancestors, never the declared protected root or symlink targets.
  // Refuse aliases before mkdir so an output symlink cannot write into platform state.
  let current = path.parse(resolved).root;
  for (const component of path.relative(current, resolved).split(path.sep)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('Restricted output path must not contain symlinks');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (contains(repositoryRoot, canonical) || contains(protectedRoot, canonical) ||
      contains(canonical, repositoryRoot) || contains(canonical, protectedRoot)) {
    throw new Error('Restricted output must not resolve to repository or protected platform storage');
  }
  const info = await stat(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Restricted output root must be operator-owned and mode 0700');
  }
  return canonical;
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid offline storage path');
  return path.resolve(value);
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
  const parts = path.relative(current, value).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new Error('Unsafe offline storage path');
      }
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Perform lexical exclusions for every argument before inspecting any filesystem path. */
export async function offlinePaths(inputDir: string, inputFiles: string[], outputRoot: string, protectedRoot: string): Promise<{
  inputDir: string; inputFiles: string[]; outputRoot: string; protectedRoot: string;
}> {
  const protectedPath = absolute(protectedRoot);
  // The operator supplies a canonical platform root; never resolve or inspect it.
  if (protectedPath !== protectedRoot) throw new Error('Invalid protected storage root');
  const directory = absolute(inputDir);
  const files = inputFiles.map(absolute);
  const output = absolute(outputRoot);
  for (const value of [directory, ...files, output]) separate(value, protectedPath);
  if (contains(directory, output) || contains(output, directory) ||
      files.some((file) => contains(output, file) || contains(file, output))) {
    throw new Error('Offline input and output must be separate');
  }
  for (const value of [directory, ...files]) await ancestors(value, false);
  await ancestors(output, true);
  await privateDirectory(directory);
  for (const file of files) await privateDirectory(path.dirname(file));
  try {
    await privateDirectory(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { inputDir: directory, inputFiles: files, outputRoot: output, protectedRoot: protectedPath };
}

export async function privateDirectory(directory: string): Promise<void> {
  await ancestors(directory, false);
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateOwned(info)) throw new Error('Unsafe private directory');
}

/** Never follow a final symlink or open a device/FIFO; bound reads even if a file grows. */
export async function privateBytes(filename: string): Promise<Buffer> {
  await privateDirectory(path.dirname(filename));
  const before = await lstat(filename);
  if (!before.isFile() || !privateOwned(before) || before.size > maxInputBytes) throw new Error('Unsafe private input file');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !privateOwned(info) || info.size > maxInputBytes ||
        info.dev !== before.dev || info.ino !== before.ino) throw new Error('Unsafe private input file');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs || !privateOwned(after)) throw new Error('Changed private input file');
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
