/**
 * 主页「额外社交链接」的读写归一（纯函数）。
 *
 * 为什么单独成一个模块：这段逻辑原本写在 `HomeSettings.vue` 的模板里，
 * 而**服务端有一份几乎相同但更严格的实现**（`saveSettings` 的 `home_social_extra` 分支：
 * `safeUrl(url, 300)` + label 必填 + 最多 8 条 + label 截 30 / url 截 300）。
 *
 * 两边规则不一致会造成一个很具体的体验问题：
 * 前端清洗后把结果写回本地（`socialExtra.value = cleaned`），用户看到列表还在；
 * 但服务端按更严格的规则丢掉了那一项 —— 于是**下次刷新页面那一项就消失了**，
 * 而用户以为自己保存成功了。实测的例子是填 `javascript:alert(1)`：
 * 前端只检查「非空」，服务端会因为协议不在白名单而丢弃。
 *
 * 所以这里把规则对齐到服务端那一套：**协议必须 http(s)、label 必填、8 条上限、长度截断**。
 * 前端先按同样规则清洗，用户能当场看到哪一项不会保存（而不是等他刷新）。
 */

/** 与服务端一致的上限 */
export const SOCIAL_MAX_ITEMS = 8;
export const SOCIAL_LABEL_MAX = 30;
export const SOCIAL_URL_MAX = 300;

/** 协议白名单：与服务端 safeUrl 的判据一致 */
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * 读：把设置里的值解析成 `[{ label, url }]`。
 *
 * 必须兼容两种形态：
 *   - 新写入 → 单编码 JSON，`getAllSettings` 解析后是**数组**
 *   - 历史数据 → 曾被双重序列化，解析后是**字符串**（还要再 parse 一次）
 * 只写 `JSON.parse(String(raw))` 会把数组变成 `"[object Object],..."` 然后 parse 失败 → 列表清空。
 *
 * @param {unknown} raw
 * @returns {Array<{label: string, url: string}>}
 */
export function parseSocialExtra(raw) {
  try {
    let list = raw;
    if (typeof list === 'string') list = JSON.parse(list || '[]');
    else if (list == null) list = [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        label: String(it.label == null ? '' : it.label),
        url: String(it.url == null ? '' : it.url),
      }));
  } catch (e) {
    return [];
  }
}

/**
 * 写前清洗：与服务端同规则。返回 `{ list, dropped }`。
 *
 * `dropped` 是被丢掉的条数 —— 调用方可以据此提示用户「有 N 项不会保存」，
 * 而不是让它们静默消失。
 *
 * @param {Array<{label?: unknown, url?: unknown}>} items
 * @returns {{ list: Array<{label: string, url: string}>, dropped: number }}
 */
export function normalizeSocialExtra(items) {
  const raw = Array.isArray(items) ? items : [];
  const cleaned = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.label == null ? '' : it.label).trim().slice(0, SOCIAL_LABEL_MAX);
    const url = String(it.url == null ? '' : it.url).trim().slice(0, SOCIAL_URL_MAX);
    // label 与 url 都必填；url 还必须在 http(s) 白名单内（与服务端一致）
    if (!label || !url) continue;
    if (!HTTP_URL_RE.test(url)) continue;
    cleaned.push({ label, url });
  }
  const list = cleaned.slice(0, SOCIAL_MAX_ITEMS);
  return { list, dropped: raw.length - list.length };
}

/** 序列化成提交给服务端的形态（单编码 JSON 字符串） */
export function serializeSocialExtra(items) {
  return JSON.stringify(normalizeSocialExtra(items).list);
}
