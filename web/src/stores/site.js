import { defineStore } from 'pinia';
import { ref } from 'vue';
import { settingsApi, statsApi } from '@/api';
import { setServerTzOffset } from '@/utils/format';

export const useSiteStore = defineStore('site', () => {
  const settings = ref({});
  const stats = ref({});
  const loaded = ref(false);

  async function fetchSettings() {
    try {
      settings.value = await settingsApi.get();
      // 注入服务器时区偏移：timeAgo 解析无时区后缀的本地时间字符串时
      // 按服务器时区解释（跨时区访客的相对时间显示才正确）
      setServerTzOffset(settings.value.server_tz_offset_min);
    } catch (e) {
      /* 忽略 */
    }
  }

  async function fetchStats() {
    try {
      stats.value = await statsApi.summary();
    } catch (e) {
      /* 忽略 */
    }
  }

  async function init() {
    if (loaded.value) return;
    await Promise.all([fetchSettings(), fetchStats()]);
    loaded.value = true;
  }

  return { settings, stats, loaded, fetchSettings, fetchStats, init };
});
