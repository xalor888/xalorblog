<template>
  <div class="about-page">
    <div class="container narrow">
      <div class="page-head fade-up">
        <p class="eyebrow">ABOUT</p>
        <h1>关于我</h1>
      </div>

      <!-- 个人卡片 -->
      <div class="profile card" v-reveal>
        <div class="profile-avatar">
          <img v-if="site.settings.avatar" :src="site.settings.avatar" alt="avatar" />
          <span v-else>X</span>
        </div>
        <h2 class="profile-name">{{ site.settings.site_name }}</h2>
        <p class="profile-desc">{{ site.settings.site_desc }}</p>
        <!-- 站点数据：与页脚统计同源（/stats/summary），展示站点活跃度 -->
        <div class="profile-stats">
          <div class="ps-item"><b class="num">{{ site.stats.article_count || 0 }}</b><span>文章</span></div>
          <div class="ps-item"><b class="num">{{ site.stats.comment_count || 0 }}</b><span>评论</span></div>
          <div class="ps-item"><b class="num">{{ formatNumber(site.stats.total_pv) }}</b><span>浏览</span></div>
          <div class="ps-item"><b class="num">{{ site.stats.total_uv || 0 }}</b><span>访客</span></div>
        </div>
        <div class="profile-social" v-if="socials.length">
          <a v-for="s in socials" :key="s.label" :href="s.url" target="_blank" rel="noopener" class="social-chip">
            <XIcon :name="s.icon" :size="14" /> {{ s.label }}
          </a>
        </div>
      </div>

      <!-- 关于内容 -->
      <div class="about-content card" v-reveal>
        <div class="markdown-body" v-html="aboutHtml"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, watchEffect } from 'vue';
import XIcon from '@/components/ui/XIcon.vue';
import { useSiteStore } from '@/stores/site';
import { renderMarkdown, addImgAttrs } from '@/utils/markdown';
import { formatNumber } from '@/utils/format';

// 浏览器标签页标题
watchEffect(() => {
  document.title = '关于';
});

const site = useSiteStore();

const socials = computed(() => {
  const list = [];
  const s = site.settings;
  if (s.social_github && !/^https?:\/\/github\.com\/?$/i.test(String(s.social_github).trim())) {
    list.push({ label: 'GitHub', url: s.social_github, icon: 'Github' });
  }
  if (s.social_weibo) list.push({ label: '微博', url: s.social_weibo, icon: 'AtSign' });
  if (s.social_email) list.push({ label: '联系邮箱', url: `mailto:${s.social_email}`, icon: 'Mail' });
  return list;
});

const aboutHtml = computed(() =>
  addImgAttrs(renderMarkdown(site.settings.about_content || '# 关于我\n\n这里写点关于你自己的介绍吧。'))
);

site.init();
</script>

<style scoped>
.about-page {
  padding-bottom: 60px;
}

.narrow {
  max-width: 720px;
}

.page-head .eyebrow {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* 个人卡片 */
.profile {
  padding: 48px 32px 36px;
  text-align: center;
  margin-bottom: 28px;
  border-radius: 24px;
}

.profile-avatar {
  width: 108px;
  height: 108px;
  border-radius: 50%;
  margin: 0 auto 18px;
  overflow: hidden;
  background: var(--bg-soft);
  border: 3px solid var(--card);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 35%, transparent), var(--shadow-1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.2rem;
  font-weight: 800;
  color: var(--accent);
}

.profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile-name {
  font-size: 1.45rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin-bottom: 8px;
}

.profile-desc {
  color: var(--text-2);
  font-size: 0.95rem;
  margin-bottom: 20px;
}

.profile-social {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
}

/* 站点数据统计 */
.profile-stats {
  display: flex;
  justify-content: center;
  gap: 0;
  margin-top: 18px;
  padding: 12px 0;
  border-top: 1px dashed var(--border);
  border-bottom: 1px dashed var(--border);
}

.ps-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 84px;
}

.ps-item + .ps-item {
  border-left: 1px dashed var(--border);
}

.ps-item b {
  font-size: 1.2rem;
  font-weight: 800;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.ps-item span {
  font-size: 0.76rem;
  color: var(--text-3);
}

.social-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 0.85rem;
  transition: all var(--dur) var(--ease);
}

.social-chip:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 关于内容 */
.about-content {
  padding: 36px 40px;
}

@media (max-width: 640px) {
  .about-content {
    padding: 24px 22px;
  }
}
</style>
