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
      const data = await statsApi.summary();
      stats.value = {
        total_pv: Number(data?.total_pv) || 0,
        total_uv: Number(data?.total_uv) || 0,
        today_pv: Number(data?.today_pv) || 0,
        today_uv: Number(data?.today_uv) || 0,
        article_count: Number(data?.article_count) || 0,
        comment_count: Number(data?.comment_count) || 0,
      };
    } catch (e) {
      /* 忽略：保留上次成功值，避免把已有数字冲成空 */
    }
  }

  async function init() {
    if (loaded.value) return;
    await Promise.all([fetchSettings(), fetchStats()]);
    loaded.value = true;
  }

  return { settings, stats, loaded, fetchSettings, fetchStats, init };
});
