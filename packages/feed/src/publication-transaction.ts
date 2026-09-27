import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ownedDirectories = ["feeds", "catalog", "bundles", "subscriptions"] as const;

export interface PublicationFile {
  path: string;
  content: string;
}

async function existingPath(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validatePublicationRoot(outputDirectory: string): Promise<void> {
  const target = resolve(outputDirectory);
  if (dirname(target) === target) {
    throw new Error("publication output directory must not be a filesystem root");
  }

  const root = await existingPath(target);
  if (!root) return;
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("unsafe publication output path: expected a directory");
  }

  for (const directory of ownedDirectories) {
    const current = await existingPath(join(target, directory));
    if (current && (current.isSymbolicLink() || !current.isDirectory())) {
      throw new Error(
        `unsafe publication path: ${directory} must be a directory, not a symbolic link or file`,
      );
    }
  }
}

async function writeStagedPublication(
  stage: string,
  files: readonly PublicationFile[],
): Promise<void> {
  await mkdir(join(stage, "feeds"), { recursive: true });
  for (const file of files) {
    const target = join(stage, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

async function commitPublication(
  stage: string,
  outputDirectory: string,
): Promise<void> {
  const target = resolve(outputDirectory);
  const transactionRoot = dirname(stage);
  const backupRoot = join(transactionRoot, "backup");
  const committed: Array<{
    target: string;
    backup: string;
    oldMoved: boolean;
    newInstalled: boolean;
  }> = [];

  try {
    for (const directory of ownedDirectories) {
      const targetPath = join(target, directory);
      const stagedPath = join(stage, directory);
      const backupPath = join(backupRoot, directory);
      const oldExists = (await existingPath(targetPath)) !== undefined;
      const newExists = (await existingPath(stagedPath)) !== undefined;
      const record = {
        target: targetPath,
        backup: backupPath,
        oldMoved: false,
        newInstalled: false,
      };
      committed.push(record);

      if (oldExists) {
        await mkdir(dirname(backupPath), { recursive: true });
        await rename(targetPath, backupPath);
        record.oldMoved = true;
      }
      if (newExists) {
        await rename(stagedPath, targetPath);
        record.newInstalled = true;
      }
    }
  } catch (error) {
    for (const record of committed.reverse()) {
      if (record.newInstalled) {
        await rm(record.target, { recursive: true, force: true });
      }
      if (record.oldMoved) {
        await rename(record.backup, record.target);
      }
    }
    throw error;
  }
}

/**
 * Replace one complete feed generation while preserving unrelated files at the
 * publication root. Rendering must be complete before this function is called.
 */
export async function publishFiles(
  outputDirectory: string,
  files: readonly PublicationFile[],
): Promise<void> {
  const target = resolve(outputDirectory);
  await validatePublicationRoot(target);
  await mkdir(target, { recursive: true });

  const transactionRoot = await mkdtemp(
    join(target, ".nju-info-publication-"),
  );
  const stage = join(transactionRoot, "stage");

  try {
    await writeStagedPublication(stage, files);
    await commitPublication(stage, target);
  } finally {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
  }
}
