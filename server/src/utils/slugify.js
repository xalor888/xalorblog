/** 生成 URL slug（拼音/英文原样保留，中文保留，防碰撞 + 长度钳制） */
function slugify(text, existing = []) {
  let base = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!base) base = `post-${Date.now()}`;
  // 超长标题截断（80 字符内），防超长 slug 拖长 URL
  if (base.length > 80) base = base.slice(0, 80).replace(/-+$/, '');
  let slug = base;
  let i = 1;
  const set = new Set(existing);
  while (set.has(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

module.exports = { slugify };
