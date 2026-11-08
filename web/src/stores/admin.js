import { defineStore } from 'pinia';
import { ref } from 'vue';
import { statsApi } from '@/api';
import { getAdminPath } from '@/utils/adminPath';

/** 后台数据：待审事项角标 */
export const useAdminStore = defineStore('admin', () => {
  const pending = ref({ comments: 0, links: 0, messages: 0 });
  const loaded = ref(false);
  /**
   * 上次拉取是否失败。
   *
   * 原来这里是一句 `/* 忽略 *\/` —— 后果不在控制台，而在**角标**：
   * 失败时 `pending` 保持 `{0,0,0}`，`badgeFor()` 看到 0 就返回空字符串，
   * 于是侧栏干干净净，管理员会以为「今天没有待审评论」。实际是接口挂了。
   * 把故障显示成空状态，是这批修复里反复出现的同一类错误。
   */
  const failed = ref(false);

  async function fetchPending() {
    try {
      await getAdminPath();
      const data = await statsApi.dashboard();
      pending.value = data.pending || { comments: 0, links: 0, messages: 0 };
      loaded.value = true;
      failed.value = false;
    } catch (e) {
      // 保留上一次的数量（比清成 0 更接近事实），只标记失败供 UI 提示
      failed.value = true;
    }
  }

  function totalPending() {
    return pending.value.comments + pending.value.links + pending.value.messages;
  }

  /**
   * 重置到初始态（登出时调用）。
   *
   * ⚠ 必须自己写，不能用 `$reset()`：Pinia 的 `$reset` **只存在于 options 式 store**
   * （`defineStore(id, { state, actions })`）。本项目全部是 setup 式
   * （`defineStore(id, () => {...})`），所以 `store.$reset?.()` 里的可选链
   * 永远是 `undefined`，调用静默失效 —— auth store 的登出清理就踩了这个坑：
   * 以为重置了角标，实际上一个会话的待审数会留给下一个登录者。
   */
  function reset() {
    pending.value = { comments: 0, links: 0, messages: 0 };
    loaded.value = false;
    failed.value = false;
  }

  return { pending, loaded, failed, fetchPending, totalPending, reset };
});
