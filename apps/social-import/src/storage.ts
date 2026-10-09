import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSocialImportJson } from '@nju-info/core';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maxInputBytes = 2 * 1024 * 1024;

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonical(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f]/.test(value) ||
      value.split(path.sep).some((part) => part.startsWith('.partial'))) {
    throw new Error('Invalid operator storage path');
  }
  return value;
}

function privateOwned(info: Stats): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

async function ancestors(filename: string, missingLeaf = false): Promise<void> {
  let current = path.parse(filename).root;
  const parts = path.relative(current, filename).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new Error('Unsafe operator storage ancestor');
      }
    } catch (error) {
      if (!missingLeaf || index !== parts.length - 1 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function privateDirectory(directory: string): Promise<void> {
  canonical(directory);
  await ancestors(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateOwned(info) || await realpath(directory) !== directory) {
    throw new Error('Operator directory must be canonical, owned and private');
  }
}

/** Validate all declared namespaces lexically BEFORE inspecting any of them.
 * The operator-supplied protected root is deliberately never stat'ed or resolved.
 * Mount aliases remain the operator's responsibility.
 */
export async function operatorPaths(inputDirectories: string[], inputFiles: string[], outputFile: string,
  protectedRoot: string, database = false): Promise<void> {
  const protectedPath = canonical(protectedRoot);
  const directories = inputDirectories.map(canonical);
  const files = inputFiles.map(canonical);
  const output = canonical(outputFile);
  const inputs = [...directories, ...files];
  const outputNamespace = database ? path.dirname(output) : output;
  for (const value of [...inputs, outputNamespace]) {
    for (const root of [repositoryRoot, protectedPath]) {
      if (contains(root, value) || contains(value, root)) throw new Error('Unsafe operator storage boundary');
    }
  }
  for (let index = 0; index < inputs.length; index++) {
    for (let other = index + 1; other < inputs.length; other++) {
      if (contains(inputs[index]!, inputs[other]!) || contains(inputs[other]!, inputs[index]!)) {
        throw new Error('Operator input namespaces overlap');
      }
    }
    if (contains(inputs[index]!, outputNamespace) || contains(outputNamespace, inputs[index]!)) {
      throw new Error('Operator input and output namespaces overlap');
    }
  }
  for (const directory of directories) await privateDirectory(directory);
  for (const file of files) {
    await privateDirectory(path.dirname(file));
    await ancestors(file);
    await privateRegular(file, maxInputBytes);
  }
  await privateDirectory(path.dirname(output));
  await ancestors(output, true);
  if (database) await privateDatabase(output);
}

async function privateRegular(filename: string, maximumBytes: number): Promise<Stats> {
  const info = await lstat(filename);
  if (!info.isFile() || !privateOwned(info) || info.nlink !== 1 || info.size > maximumBytes) {
    throw new Error('Unsafe private regular file');
  }
  return info;
}

export async function privateDatabase(filename: string): Promise<void> {
  let present = false;
  try {
    await privateRegular(filename, Number.POSITIVE_INFINITY);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await privateRegular(filename + suffix, Number.POSITIVE_INFINITY);
      if (!present) throw new Error('Orphaned database sidecar');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && privateOwned(right) && right.nlink === 1 && left.dev === right.dev &&
    left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Stable bounded reads refuse symlinks, hardlinks, FIFO/device files and changes. */
export async function privateBytes(filename: string, maximumBytes = maxInputBytes): Promise<Buffer> {
  canonical(filename);
  await privateDirectory(path.dirname(filename));
  const before = await privateRegular(filename, maximumBytes);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!sameFile(before, info)) throw new Error('Changed private input');
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== info.size || !sameFile(info, await handle.stat()) || !sameFile(info, await lstat(filename))) {
      throw new Error('Changed private input');
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}


export async function privateJson(filename: string): Promise<unknown> {
  return parseSocialImportJson(await privateBytes(filename));
}

/** Explicit exclusive output; existing operator files are never overwritten. */
export async function privateWrite(filename: string, value: unknown): Promise<void> {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
