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

  /**
   * 整站阅读统计（总字数 / 篇数 / 篇均 / 最长一篇 / 累计阅读时长）。
   *
   * 与 stats 分开存：它来自另一个端点、刷新节奏也不同（管理员改文章后
   * 才有意义），混进 stats 会让「访问量刷新」顺带把阅读统计也重置一遍。
   * 失败时保留 null 而不是 {} —— UI 据此决定**整块不渲染**，
   * 而不是渲染出一堆 0（「0 字」比不显示更糟）。
   */
  const reading = ref(null);

  async function fetchReading() {
    try {
      const data = await statsApi.reading();
      // 后端已保证是数字；这里再兜一层，避免渲染出 undefined / NaN
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      reading.value = {
        total_words: num(data?.total_words),
        total_articles: num(data?.total_articles),
        avg_words: num(data?.avg_words),
        total_reading_minutes: num(data?.total_reading_minutes),
        longest: data?.longest && typeof data.longest === 'object' ? data.longest : null,
      };
    } catch (e) {
      /* 忽略：保留上次成功值；从未成功过则保持 null，UI 整块不渲染 */
    }
  }

  async function init() {
    if (loaded.value) return;
    // 阅读统计不参与 loaded 的判定：它是增强信息，失败不该拖住整站初始化
    await Promise.all([fetchSettings(), fetchStats(), fetchReading()]);
    loaded.value = true;
  }

  return { settings, stats, reading, loaded, fetchSettings, fetchStats, fetchReading, init };
});
