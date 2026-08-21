/**
 * §9: files whose contents are never copied into the state file — the path and
 * selected range are still recorded, only `text` is omitted. Pure, no vscode
 * import, and no glob-matching dependency (design.md §0: zero runtime deps) —
 * the patterns in practice (`**\/.env`, `**\/*.pem`, ...) are simple enough that
 * a small hand-rolled matcher covers them without pulling in micromatch.
 */
export function isExcluded(path: string | null, globs: string[]): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/');
  return globs.some(glob => globToRegExp(glob).test(normalized));
}

const cache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;

  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**` matches any depth, including zero segments (so `**/.env` matches a
      // top-level `.env` too) — consume an optional following slash.
      pattern += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      pattern += '[^/]*';
    } else if (c === '?') {
      pattern += '[^/]';
    } else {
      pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const re = new RegExp(`^${pattern}$`);
  cache.set(glob, re);
  return re;
}
