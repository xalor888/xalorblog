/**
 * 会话级浏览器存储：敏感数据只在当前标签页存活。
 *
 * 读取时会把旧版本遗留在 localStorage 的值迁入 sessionStorage，并立即删除
 * 持久副本。即使浏览器禁用 sessionStorage，本次调用仍返回旧值，调用方可在
 * 内存中继续使用，但不会为了兼容而继续长期保留敏感数据。
 */

function getStorage(name) {
  try {
    return globalThis[name] || null;
  } catch (e) {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch (e) {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, String(value));
    return !!storage;
  } catch (e) {
    return false;
  }
}

function remove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch (e) {
    /* 隐私模式/存储被禁用时忽略 */
  }
}

/** 读取会话值；若仅存在旧 localStorage 值，则迁移并清理旧副本。 */
export function readSessionValue(key) {
  const session = getStorage('sessionStorage');
  const local = getStorage('localStorage');
  const current = read(session, key);
  if (current !== null) {
    remove(local, key);
    return current;
  }

  const legacy = read(local, key);
  if (legacy === null) return '';
  write(session, key, legacy);
  remove(local, key);
  return legacy;
}

/** 仅写入当前标签页；同时删除可能残留的 localStorage 旧值。 */
export function writeSessionValue(key, value) {
  const session = getStorage('sessionStorage');
  const local = getStorage('localStorage');
  remove(local, key);
  if (value === '' || value === null || value === undefined) {
    remove(session, key);
    return true;
  }
  return write(session, key, value);
}

/** 从会话存储及旧持久存储中同时删除。 */
export function removeStoredValue(key) {
  remove(getStorage('sessionStorage'), key);
  remove(getStorage('localStorage'), key);
}

/** 将一组旧持久值迁入当前标签页。 */
export function migrateLegacyKeys(keys) {
  for (const key of keys) readSessionValue(key);
}

/** 将指定前缀的全部旧键迁入当前标签页（用于旧版后台文章草稿）。 */
export function migrateLegacyPrefix(prefix) {
  const local = getStorage('localStorage');
  if (!local) return;
  const keys = [];
  try {
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch (e) {
    return;
  }
  for (const key of keys) readSessionValue(key);
}

/** 清理当前标签页及旧持久存储中匹配前缀的全部键。 */
export function clearStoredPrefix(prefix) {
  for (const storage of [getStorage('sessionStorage'), getStorage('localStorage')]) {
    if (!storage) continue;
    const keys = [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
    } catch (e) {
      continue;
    }
    for (const key of keys) remove(storage, key);
  }
}
