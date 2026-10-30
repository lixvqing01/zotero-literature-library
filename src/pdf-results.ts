import { AppError, parseDocument } from './core';

export async function importArchive(zipPath: string, target: string) {
  const archive = Cc['@mozilla.org/libjar/zip-reader;1'].createInstance(Ci.nsIZipReader);
  const file = Zotero.File.pathToFile(zipPath);
  let total = 0;
  const entries: string[] = [];
  try {
    archive.open(file);
    const found = archive.findEntries('*');
    while (found.hasMore()) {
      const name = found.getNext();
      if (name.endsWith('/')) continue;
      if (name.includes('\\') || name.startsWith('/') || name.split('/').some((p: string) => p === '..' || p.includes(':')))
        throw new Error('不安全的解压路径。');
      const entry = archive.getEntry(name);
      if (entry.isSymlink) throw new Error('结果压缩包不能包含符号链接。');
      total += entry.realSize;
      if (total > 512 * 1024 * 1024 || entry.realSize > 100 * 1024 * 1024 || entries.length >= 5000)
        throw new Error('MinerU 结果压缩包超过安全解压上限。');
      if (!/\.(md|json|png|jpg|jpeg|webp|gif)$/i.test(name)) continue;
      entries.push(name);
      const dest = PathUtils.join(target, ...name.split('/'));
      await IOUtils.makeDirectory(PathUtils.parent(dest), { ignoreExisting: true });
      archive.extract(name, Zotero.File.pathToFile(dest));
    }
  } finally { try { archive.close(); } catch {} }
  const markdownName = entries.find(n => /(^|\/)full\.md$/i.test(n)) ?? entries.find(n => n.endsWith('.md'));
  if (!markdownName) throw new AppError({ code: 'MINERU_BAD_ARCHIVE', message: 'MinerU 结果缺少 Markdown。', retryable: false });
  const markdown = await IOUtils.readUTF8(PathUtils.join(target, ...markdownName.split('/')));
  const contentName = entries.find(n => /content_list\.json$/i.test(n));
  let list: any[] = [];
  if (contentName) {
    const parsed = JSON.parse(await IOUtils.readUTF8(PathUtils.join(target, ...contentName.split('/'))));
    if (Array.isArray(parsed)) list = parsed;
  }
  if (!markdown.trim()) throw new Error('MinerU 返回空 Markdown。');
  return { markdown, ...parseDocument(markdown, list) };
}
