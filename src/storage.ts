type FileIO = {
  getChildren(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type?: string; size?: number }>;
  remove(path: string): Promise<void>;
};

async function measure(path: string, io: FileIO): Promise<number> {
  let stat: { type?: string; size?: number };
  try { stat = await io.stat(path); } catch { return 0; }
  if (stat.type !== 'directory') return Math.max(0, Number(stat.size) || 0);
  let total = 0;
  let children: string[];
  try { children = await io.getChildren(path); } catch { return 0; }
  for (const child of children) total += await measure(child, io);
  return total;
}

export async function storageUsage(root: string, io: FileIO = IOUtils as FileIO) {
  const documents = await measure(PathUtils.join(root, 'documents'), io);
  const models = await measure(PathUtils.join(root, 'models'), io);
  const database = (await measure(PathUtils.join(root, 'library.sqlite'), io))
    + (await measure(PathUtils.join(root, 'library.sqlite-wal'), io))
    + (await measure(PathUtils.join(root, 'library.sqlite-shm'), io));
  return { documents, models, database, total: documents + models + database };
}

export async function removeResultArchives(root: string, io: FileIO = IOUtils as FileIO): Promise<number> {
  let removed = 0;
  let children: string[];
  try { children = await io.getChildren(root); } catch { return 0; }
  for (const child of children) {
    let stat: { type?: string };
    try { stat = await io.stat(child); } catch { continue; }
    if (stat.type === 'directory') removed += await removeResultArchives(child, io);
    else if (/[/\\]result\.zip$/i.test(child)) {
      try { await io.remove(child); removed++; } catch { /* Keep startup cleanup best effort. */ }
    }
  }
  return removed;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
