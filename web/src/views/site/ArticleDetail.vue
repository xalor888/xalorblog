<template>
  <div class="article-detail">
    <!-- 阅读进度条 -->
    <div class="progress-track">
      <div class="progress-fill" :style="{ '--p': progress / 100 }"></div>
    </div>

    <div class="container detail-layout">
      <!-- 加载骨架 -->
      <div v-if="!article && loading" class="detail-main" aria-hidden="true">
        <div class="sk-head">
          <div class="skeleton sk-line" style="width: 32%; height: 18px;"></div>
          <div class="skeleton sk-title"></div>
          <div class="skeleton sk-title" style="width: 72%;"></div>
          <div class="skeleton sk-line" style="width: 46%; height: 14px; margin-top: 18px;"></div>
        </div>
        <div class="skeleton sk-cover"></div>
        <div class="skeleton sk-text"></div>
        <div class="skeleton sk-text" style="width: 92%;"></div>
        <div class="skeleton sk-text" style="width: 86%;"></div>
        <div class="skeleton sk-text" style="width: 95%;"></div>
        <div class="skeleton sk-text" style="width: 60%;"></div>
      </div>

      <!-- 加载失败（文章不存在 / 网络异常） -->
      <div v-else-if="loadError" class="detail-main">
        <div class="load-error fade-up">
          <span class="le-float" aria-hidden="true">?</span>
          <p class="le-code">{{ loadErrorCode }}</p>
          <h2 class="le-title">{{ loadError }}</h2>
          <p class="le-desc">文章可能已被删除，或网络暂时开小差</p>
          <div class="le-actions">
            <router-link to="/" class="btn-primary">
              <XIcon name="House" :size="15" /> 回到首页
            </router-link>
            <button class="btn-ghost" @click="retryLoad">
              <XIcon name="RefreshCw" :size="15" /> 重试
            </button>
          </div>
        </div>
      </div>

      <article v-if="article" class="detail-main">
        <!-- 文章头 -->
        <header class="detail-head fade-up">
          <div class="head-meta">
            <router-link
              v-if="article.category_name"
              :to="{ path: '/articles', query: { category: article.category_slug } }"
              class="head-cat"
              :style="{ '--cat': article.category_color || 'var(--accent)' }"
            >
              {{ article.category_name }}
            </router-link>
            <span v-else class="head-cat muted">未分类</span>
            <span v-if="article.is_top" class="head-pin"><XIcon name="Pin" :size="13" /> 置顶</span>
            <div class="head-actions">
              <button
                class="share-btn"
                :class="{ active: bookmarked }"
                :title="bookmarked ? '取消收藏' : '收藏本文'"
                @click="toggleBookmark"
              >
                <XIcon name="Bookmark" :size="15" :fill="bookmarked" :stroke-width="bookmarked ? 0 : 1.8" />
              </button>
              <button class="share-btn" title="复制链接" aria-label="复制链接" @click="copyLink">
                <XIcon name="Link" :size="15" />
              </button>
              <button class="share-btn" title="导出 Markdown" aria-label="导出 Markdown" @click="exportMarkdown">
                <XIcon name="Download" :size="15" />
              </button>
              <button class="share-btn" title="打印本文" aria-label="打印本文" @click="window.print()">
                <XIcon name="Printer" :size="15" />
              </button>
              <button class="share-btn" title="分享" aria-label="分享" @click="openShare">
                <XIcon name="Share2" :size="15" />
              </button>
              <transition name="share-pop">
                <div v-if="shareMenu" class="share-menu">
                  <a :href="`https://service.weibo.com/share/share.php?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener" class="share-item">
                    <XIcon name="AtSign" :size="15" /> 微博
                  </a>
                  <a :href="`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener" class="share-item">
                    <XIcon name="Twitter" :size="15" /> Twitter
                  </a>
                  <a :href="`https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener" class="share-item">
                    <XIcon name="Share2" :size="15" /> QQ 空间
                  </a>
                  <a :href="`https://www.zhihu.com/share?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener" class="share-item">
                    <XIcon name="MessageCircleHeart" :size="15" /> 知乎
                  </a>
                  <a :href="`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener" class="share-item">
                    <XIcon name="Send" :size="15" /> Telegram
                  </a>
                  <button class="share-item" @click="copyLink">
                    <XIcon name="Copy" :size="15" /> 复制链接
                  </button>
                </div>
              </transition>
            </div>
          </div>

          <h1 class="detail-title">{{ article.title }}</h1>

          <div class="detail-meta">
            <span class="dm-item"><XIcon name="Calendar" :size="14" /> {{ formatDate(article.published_at) }}</span>
            <span class="dm-item"><XIcon name="Clock" :size="14" /> {{ readingTime(article.content) }} 分钟</span>
            <span class="dm-sep"></span>
            <span class="dm-item"><XIcon name="FileText" :size="14" /> {{ wordCount }} 字</span>
            <span class="dm-sep"></span>
            <span class="dm-item"><XIcon name="Eye" :size="14" /> {{ formatNumber(article.views) }} 阅读</span>
            <span class="dm-sep"></span>
            <span class="dm-item dm-link" title="跳到评论区" aria-label="跳到评论区" @click="scrollToComments">
              <XIcon name="MessageSquare" :size="14" /> {{ article.comment_count }} 评论
            </span>
          </div>

          <div v-if="article.tags.length" class="detail-tags">
            <router-link v-for="t in article.tags" :key="t.id" :to="{ path: '/articles', query: { tag: t.slug } }" class="d-tag">
              # {{ t.name }}
            </router-link>
          </div>
        </header>

        <!-- 封面 -->
        <div v-if="article.cover" class="detail-cover fade-up">
          <img
            :src="article.cover"
            :alt="article.title"
            decoding="async"
            fetchpriority="high"
            @error="$event.target.closest('.detail-cover').classList.add('cover-failed')"
          />
          <div class="cover-err" aria-hidden="true">
            <XIcon name="ImageOff" :size="34" />
          </div>
        </div>

      <!-- 正文 -->
      <div class="detail-content fade-up">
        <div class="reading-toolbar">
          <span class="rt-label">字号</span>
          <button class="rt-btn" :class="{ dim: fontSize <= 14 }" @click="changeFontSize(-1)" title="减小字号">A−</button>
          <button class="rt-btn" :class="{ dim: fontSize >= 20 }" @click="changeFontSize(1)" title="增大字号">A+</button>
          <span class="rt-sep"></span>
          <span class="rt-label">字体</span>
          <button class="rt-btn rt-wide" @click="toggleFontStyle" :title="fontStyle === 'serif' ? '切换到无衬线字体' : '切换到衬线字体'">
            {{ fontStyle === 'serif' ? '衬线' : '无衬线' }}
          </button>
        </div>
        <div v-if="article.content_decrypt_failed" class="decrypt-fail">
          正文解密失败，请刷新页面后重试。
        </div>
        <div v-else class="markdown-body" :class="{ serif: fontStyle === 'serif' }" v-html="renderedContent" :style="{ fontSize: fontSize + 'px' }" @click="onContentClick"></div>

          <!-- 点赞 -->
          <div class="like-zone">
            <button class="like-btn" :class="{ liked }" @click="doLike" :disabled="liked">
              <span class="heart">
                <XIcon :name="liked ? 'Heart' : 'Heart'" :size="20" :fill="liked" :stroke-width="liked ? 0 : 1.8" />
              </span>
              <span>{{ article.likes }}</span>
            </button>
            <p class="like-hint">{{ liked ? '已感谢你的喜欢' : '觉得不错就点个赞吧' }}</p>
          </div>
        </div>

        <!-- 版权声明 -->
        <div class="copyright-card card">
          <div class="cc-head">
            <XIcon name="ScrollText" :size="16" />
            <span class="cc-title">版权声明</span>
          </div>
          <p v-if="copyrightText" class="cc-text">{{ copyrightText }}</p>
          <p v-else class="cc-text">
            本文由 <b>{{ site.settings.site_name || 'Xalor' }}</b> 原创，采用
            <a :href="ccLicenseUrl" target="_blank" rel="noopener">署名-非商业性使用 4.0 国际 (CC BY-NC 4.0)</a>
            协议。转载请注明出处及原文链接。
          </p>
          <div class="cc-actions">
            <button class="cc-btn" @click="copyLink"><XIcon name="Link" :size="13" /> 复制本文链接</button>
            <span class="cc-url">{{ shareUrl }}</span>
          </div>
        </div>

        <!-- 上一篇/下一篇 -->
        <nav class="neighbors">
          <router-link v-if="neighbors.prev" :to="`/article/${neighbors.prev.slug}`" class="nb-card prev">
            <span class="nb-label"><XIcon name="ArrowLeft" :size="13" /> 上一篇</span>
            <span class="nb-title">{{ neighbors.prev.title }}</span>
          </router-link>
          <span v-else class="nb-card prev empty"><span class="nb-label"><XIcon name="ArrowLeft" :size="13" /> 上一篇</span><span class="nb-title muted">没有更早的文章</span></span>

          <router-link v-if="neighbors.next" :to="`/article/${neighbors.next.slug}`" class="nb-card next">
            <span class="nb-label">下一篇 <XIcon name="ArrowRight" :size="13" /></span>
            <span class="nb-title">{{ neighbors.next.title }}</span>
          </router-link>
          <span v-else class="nb-card next empty"><span class="nb-label">下一篇 <XIcon name="ArrowRight" :size="13" /></span><span class="nb-title muted">没有更新的文章</span></span>
        </nav>

        <!-- 相关文章 -->
        <div v-if="related.length" class="related-block">
          <h3 class="related-title">相关阅读</h3>
          <div class="related-grid">
            <router-link v-for="r in related" :key="r.id" :to="`/article/${r.slug}`" class="related-card card">
              <span v-if="r.cover" class="rc-cover" :style="{ backgroundImage: `url(${r.cover})` }"></span>
              <span v-else class="rc-bar" :style="{ background: r.category_color || 'var(--accent)' }"></span>
              <div class="rc-body">
                <span class="rc-title">{{ r.title }}</span>
                <span class="rc-meta">
                  <XIcon name="Eye" :size="12" /> {{ r.views }} 阅读
                </span>
              </div>
              <XIcon name="ArrowUpRight" :size="15" class="rc-arrow" />
            </router-link>
          </div>
        </div>

        <!-- 评论 -->
        <CommentSection
          v-if="article.allow_comment"
          :article-id="article.id"
          :initial-highlight="route.query.comment"
          class="comments"
        />
        <div v-else class="comments-disabled">
          <XIcon name="MessageSquareOff" :size="22" />
          <p>本文评论已关闭</p>
        </div>
      </article>

      <!-- 图片灯箱 -->
      <ImageLightbox ref="lightboxRef" />

      <!-- 移动端：悬浮按钮（点赞 / 评论 / 目录 / 回顶） -->
      <div class="float-actions">
        <button class="fab" :class="{ liked }" :title="liked ? '已点赞' : '点赞'" @click="doLike">
          <XIcon name="Heart" :size="18" :fill="liked" />
          <span v-if="article?.likes" class="fab-num">{{ article.likes }}</span>
        </button>
        <button class="fab" title="跳到评论区" aria-label="跳到评论区" @click="scrollToComments">
          <XIcon name="MessageSquare" :size="18" />
          <span v-if="article?.comment_count" class="fab-num">{{ article.comment_count }}</span>
        </button>
        <button v-if="toc.length" class="fab" title="打开目录" aria-label="打开目录" @click="mobileTocOpen = true">
          <XIcon name="ListTree" :size="18" />
        </button>
        <button class="fab" title="回到顶部" aria-label="回到顶部" @click="scrollTop">
          <XIcon name="ArrowUp" :size="18" />
        </button>
      </div>

      <!-- 移动端：目录抽屉 -->
      <transition name="toc-mask">
        <div v-if="mobileTocOpen" class="toc-mask" @click="mobileTocOpen = false">
          <div class="toc-drawer" @click.stop>
            <div class="td-head">
              <p class="td-title">目录</p>
              <button class="td-close" title="关闭" @click="mobileTocOpen = false"><XIcon name="X" :size="16" /></button>
            </div>
            <div class="td-progress">
              <div class="td-progress-fill" :style="{ width: progress + '%' }"></div>
            </div>
            <div class="td-list">
              <a
                v-for="item in toc"
                :key="item.id"
                :href="'#' + item.id"
                :class="['td-item', 'lvl-' + item.level, { active: activeHeading === item.id }]"
                @click.prevent="scrollToHeading(item.id); mobileTocOpen = false;"
              >
                {{ item.text }}
              </a>
            </div>
          </div>
        </div>
      </transition>

      <!-- TOC 侧栏 -->
      <aside v-if="toc.length" class="detail-side">
        <div class="toc-box">
          <button class="toc-toggle" @click="toggleToc">
            <span class="toc-title">目录</span>
            <XIcon :name="tocCollapsed ? 'ChevronDown' : 'ChevronUp'" :size="14" class="toc-chev" />
          </button>
          <transition name="toc-collapse">
            <div v-show="!tocCollapsed" class="toc-list">
              <a
                v-for="item in toc"
                :key="item.id"
                :href="'#' + item.id"
                class="toc-item"
                :class="['lvl-' + item.level, { active: activeHeading === item.id }]"
                @click.prevent="scrollToHeading(item.id)"
              >
                {{ item.text }}
              </a>
            </div>
          </transition>
        </div>
        <div class="read-progress-box">
          <p class="rp-label">阅读进度</p>
          <div class="rp-track">
            <div class="rp-fill" :style="{ width: progress + '%' }"></div>
          </div>
          <p class="rp-percent num">{{ Math.round(progress) }}%</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import ImageLightbox from '@/components/ui/ImageLightbox.vue';
import CommentSection from '@/components/site/CommentSection.vue';
import { articleApi } from '@/api';
import { renderMarkdown, extractToc, addHeadingIds, addImgAttrs } from '@/utils/markdown';
import { formatDate, formatNumber, readingTime } from '@/utils/format';
import { isBookmarked, addBookmark, removeBookmark } from '@/utils/bookmark';
import { useSiteStore } from '@/stores/site';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';

const route = useRoute();
const router = useRouter();
const site = useSiteStore();

const article = ref(null);
const loading = ref(true);
const loadError = ref('');
const loadErrorCode = ref('404');
const neighbors = ref({ prev: null, next: null });
const related = ref([]);
const toc = ref([]);
const liked = ref(false);
const activeHeading = ref('');
const progress = ref(0);
const shareMenu = ref(false);
// 目录折叠偏好记忆（多数读者习惯固定展开/收起）
const tocCollapsed = ref(localStorage.getItem('xalor_toc_collapsed') === '1');
function toggleToc() {
  tocCollapsed.value = !tocCollapsed.value;
  try {
    localStorage.setItem('xalor_toc_collapsed', tocCollapsed.value ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
}
const fontSize = ref(Number(localStorage.getItem('xalor_font_size')) || 16);
const fontStyle = ref(localStorage.getItem('xalor_font_style') || 'sans');
const mobileTocOpen = ref(false);
const lightboxRef = ref(null);
const bookmarked = ref(false);

// 移动端 TOC 抽屉打开时锁定背景滚动（与灯箱行为对齐）
watch(mobileTocOpen, (open) => {
  if (open) lockBodyScroll();
  else unlockBodyScroll();
});

const ccLicenseUrl = 'https://creativecommons.org/licenses/by-nc/4.0/';

// 自定义版权声明（纯文本，模板插值自动转义）；留空回退默认 CC 声明
const copyrightText = computed(() => String(site.settings.copyright_text || '').trim());

/** 正文图片点击放大 */
function onContentClick(e) {
  const img = e.target.closest('img');
  if (img && img.closest('.markdown-body')) {
    lightboxRef.value?.open(img.src, img.alt);
  }
}

/** 字体大小调节（14-20px，localStorage 记忆） */
function changeFontSize(delta) {
  const next = Math.min(20, Math.max(14, fontSize.value + delta));
  fontSize.value = next;
  localStorage.setItem('xalor_font_size', String(next));
}

/** 正文字体风格切换（无衬线/衬线，localStorage 记忆） */
function toggleFontStyle() {
  fontStyle.value = fontStyle.value === 'serif' ? 'sans' : 'serif';
  localStorage.setItem('xalor_font_style', fontStyle.value);
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 评论数统计点击：平滑滚动到评论区（含偏移补偿 sticky 导航） */
function scrollToComments() {
  const el = document.querySelector('.comments, .comments-disabled');
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 70;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/** 收藏 / 取消收藏（本地书签） */
function toggleBookmark() {
  if (!article.value) return;
  if (bookmarked.value) {
    removeBookmark(article.value.id);
    bookmarked.value = false;
    ElMessage.success('已取消收藏');
  } else {
    addBookmark(article.value);
    bookmarked.value = true;
    ElMessage.success('已收藏，可在页脚"我的收藏"查看');
  }
}

const wordCount = computed(() => {
  if (!article.value) return 0;
  const cn = (article.value.content.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (article.value.content.match(/[a-zA-Z0-9]+/g) || []).length;
  return cn + en;
});

const shareUrl = computed(() => {
  if (!article.value) return '';
  return `${window.location.origin}/api/share/${article.value.slug}`;
});

/**
 * canonical：与分享页（服务端 HTML）的 canonical 完全一致的收录目标 URL。
 * 域名优先站点设置的 site_url（规范域名），与 RSS/Sitemap/分享页同源，
 * 避免访问域名与规范域名不一致时出现双 canonical。
 */
const canonicalUrl = computed(() => {
  if (!article.value) return '';
  const base = String(site.settings.site_url || window.location.origin).replace(/\/+$/, '');
  return `${base}/api/share/${article.value.slug}`;
});

/** 分享：支持原生 Web Share API 时直接调起系统分享（移动端），否则显示菜单 */
async function openShare() {
  if (navigator.share && window.isSecureContext) {
    try {
      await navigator.share({
        title: article.value?.title || document.title,
        text: article.value?.summary || '',
        url: window.location.href,
      });
      return;
    } catch (e) {
      // 用户取消分享：忽略；其他失败回退到菜单
      if (e?.name === 'AbortError') return;
    }
  }
  shareMenu.value = !shareMenu.value;
  if (shareMenu.value) {
    // 菜单打开时挂载外部点击关闭（排除菜单与按钮自身）
    // 注意：setTimeout 延迟添加存在卸载竞态 —— 回调执行前卸载会导致监听泄漏
    // （指向已卸载组件的闭包）；timer 记录 + onUnmounted 清理兜底
    shareClickTimer = setTimeout(() => document.addEventListener('click', onShareDocClick), 0);
  } else {
    clearTimeout(shareClickTimer);
    document.removeEventListener('click', onShareDocClick);
  }
}

/** 分享菜单外部点击监听的延迟挂载定时器（卸载竞态兜底） */
let shareClickTimer = null;

/** 点击菜单外部关闭分享浮层 */
function onShareDocClick(e) {
  if (e.target?.closest?.('.share-menu') || e.target?.closest?.('.share-btn')) return;
  shareMenu.value = false;
  document.removeEventListener('click', onShareDocClick);
}

function copyLink() {
  const url = window.location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => ElMessage.success('链接已复制'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    ElMessage.success('链接已复制');
  }
  shareMenu.value = false;
  document.removeEventListener('click', onShareDocClick);
}

/** 导出文章为 Markdown 文件（YAML front matter 标准格式，兼容 Obsidian/Hugo 等） */
function exportMarkdown() {
  if (!article.value) return;
  const a = article.value;
  const tagStr = (a.tags || []).map((t) => t.name);
  const meta = [
    '---',
    `title: "${String(a.title).replace(/"/g, '\\"')}"`,
    `slug: ${a.slug || ''}`,
    `date: ${formatDate(a.published_at)}`,
    `category: "${String(a.category_name || '未分类')}"`,
    `tags: [${tagStr.map((t) => `"${String(t).replace(/"/g, '\\"')}"`).join(', ')}]`,
    a.cover ? `cover: ${a.cover}` : '',
    `views: ${a.views}`,
    `likes: ${a.likes}`,
    '---',
    '',
    `# ${a.title}`,
    '',
    a.summary ? `> ${a.summary}\n` : '',
    '',
    '---',
    '',
  ].filter((line) => line !== '').join('\n');
  const full = meta + (a.content || '');
  const blob = new Blob([full], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${a.slug || 'article'}.md`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  ElMessage.success('Markdown 已导出');
}

const renderedContent = computed(() => {
  if (!article.value) return '';
  const html = renderMarkdown(article.value.content);
  return addImgAttrs(addHeadingIds(html));
});

let loadSeq = 0; // 请求序号：slug 快速切换时丢弃过期响应，防旧文章覆盖新文章
async function load() {
  const my = ++loadSeq;
  loading.value = true;
  loadError.value = '';
  try {
    const a = await articleApi.detail(route.params.slug);
    if (my !== loadSeq) return; // 已有更新的请求，丢弃本次响应
    article.value = a;
    applyPageMeta();
    toc.value = extractToc(a.content);
    liked.value = !!localStorage.getItem(`xalor_liked_${a.id}`);
    bookmarked.value = isBookmarked(a.id);
    // 次要数据（上一篇/下一篇/相关文章）：独立容错，失败降级为空，不影响正文展示
    try {
      const [n, r] = await Promise.all([
        articleApi.neighbors(a.id),
        articleApi.related(a.id),
      ]);
      if (my !== loadSeq) return;
      neighbors.value = n;
      related.value = r;
    } catch (e) {
      if (my !== loadSeq) return;
      neighbors.value = { prev: null, next: null };
      related.value = [];
    }
    await nextTick();
    setupTocObserver(); // 标题渲染完成后建立 TOC 高亮观察
  } catch (e) {
    if (my !== loadSeq) return; // 过期请求的错误同样丢弃
    article.value = null;
    const status = e?.response?.status;
    if (status === 404) {
      loadErrorCode.value = '404';
      loadError.value = '文章不存在或已删除';
    } else {
      loadErrorCode.value = status ? String(status) : '!';
      loadError.value = '加载失败，请稍后重试';
    }
  } finally {
    if (my === loadSeq) loading.value = false;
  }
}

/** 失败后重试 */
function retryLoad() {
  load();
}

/** 动态更新页面标题与分享元信息（SEO / 社交分享）
 * canonical 指向分享页（/api/share/:slug，真实 HTML，搜索引擎收录目标） */
function applyPageMeta() {
  const a = article.value;
  if (!a) return;
  const name = site.settings.site_name || 'Xalor的小站';
  document.title = `${a.title} · ${name}`;
  setMeta('description', a.summary || a.title);
  setMeta('og:title', `${a.title} · ${name}`);
  setMeta('og:description', a.summary || a.title);
  setMeta('og:type', 'article');
  // og:url 指向 SPA 文章页（社交平台分享跳转目标）
  setMeta('og:url', shareUrl.value);
  // og:image：文章封面绝对化（站内相对路径 → 站点设置域名），无封面时不设置
  const cover = a.cover
    ? (/^https?:\/\//i.test(a.cover)
        ? a.cover
        : `${String(site.settings.site_url || window.location.origin).replace(/\/+$/, '')}${a.cover.startsWith('/') ? '' : '/'}${a.cover}`)
    : '';
  if (cover) setMeta('og:image', cover);
  // Twitter 卡片：有封面用大图卡，否则摘要卡
  setMeta('twitter:card', cover ? 'summary_large_image' : 'summary');
  setMeta('twitter:title', `${a.title} · ${name}`);
  setMeta('twitter:description', (a.summary || a.title).slice(0, 200));
  if (cover) setMeta('twitter:image', cover);
  // canonical 与分享页（服务端 HTML）完全一致，指向收录目标自身 URL：
  // SPA hash 页不可被搜索引擎收录，收录权统一归 /api/share/:slug
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', canonicalUrl.value);
  applyJsonLd();
}

/** 注入 JSON-LD 结构化数据（BlogPosting：富摘要/知识图谱收录） */
function applyJsonLd() {
  const a = article.value;
  if (!a) return;
  const name = site.settings.site_name || 'Xalor的小站';
  const author = site.settings.author || site.settings.nickname || name;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: a.title,
    description: (a.summary || a.title).slice(0, 200),
    datePublished: a.published_at,
    dateModified: a.updated_at || a.published_at,
    mainEntityOfPage: { '@type': 'WebPage', '@id': shareUrl.value },
    author: { '@type': 'Person', name: author },
    publisher: { '@type': 'Organization', name, logo: site.settings.avatar ? { '@type': 'ImageObject', url: site.settings.avatar } : undefined },
    image: a.cover || site.settings.avatar || undefined,
  };
  if (Array.isArray(a.tags) && a.tags.length) ld.keywords = a.tags.map((t) => t.name).join(', ');
  setJsonLd('jsonld-blogposting', ld);
}

function setJsonLd(id, obj) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(obj).replace(/</g, '\\u003c');
}

/** 离开文章页时移除本文的 JSON-LD，避免与其他页面结构化数据叠加 */
function removeJsonLd() {
  document.getElementById('jsonld-blogposting')?.remove();
}

function setMeta(prop, content) {
  let el = document.querySelector(`meta[property="${prop}"]`);
  if (!el) el = document.querySelector(`meta[name="${prop}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(prop.includes(':') ? 'property' : 'name', prop);
    document.head.appendChild(el);
  }
  el.setAttribute('content', String(content).slice(0, 300));
}

async function doLike() {
  if (liked.value) return;
  try {
    const res = await articleApi.like(article.value.id);
    article.value.likes = res.likes;
    liked.value = true;
    localStorage.setItem(`xalor_liked_${article.value.id}`, '1');
    ElMessage.success('感谢点赞 ❤️');
  } catch (e) {
    /* 拦截器已提示 */
  }
}

function scrollToHeading(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 键盘导航：← 上一篇 / → 下一篇 / ESC 关闭移动端目录 */
function onKeydown(e) {
  // 输入框聚焦时不触发
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'Escape') {
    if (mobileTocOpen.value) mobileTocOpen.value = false;
    if (shareMenu.value) {
      shareMenu.value = false;
      document.removeEventListener('click', onShareDocClick);
    }
    return;
  }
  if (e.key === 'ArrowLeft' && neighbors.value.prev) {
    router.push(`/article/${neighbors.value.prev.slug}`);
  } else if (e.key === 'ArrowRight' && neighbors.value.next) {
    router.push(`/article/${neighbors.value.next.slug}`);
  }
}

/** 滚动监听：阅读进度（rAF 节流）+ TOC 高亮由 IntersectionObserver 负责 */
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    progress.value = max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0;
    ticking = false;
  });
}

/**
 * TOC 高亮：IntersectionObserver 观察标题（比 scroll 轮询高效，
 * 浏览器自动节流，无需每帧 getBoundingClientRect 遍历）
 */
let tocObserver = null;

function setupTocObserver() {
  tocObserver?.disconnect();
  tocObserver = new IntersectionObserver(
    (entries) => {
      // 激活区 = 视口顶部往下 110px 起、高度 30% 的带状区域
      const visible = entries.filter((e) => e.isIntersecting);
      if (!visible.length) return;
      let best = null;
      for (const v of visible) {
        const rect = v.target.getBoundingClientRect();
        if (!best || rect.top < best.top) best = { id: v.target.id, top: rect.top };
      }
      if (best) activeHeading.value = best.id;
    },
    { rootMargin: '-110px 0px -70% 0px', threshold: 0 }
  );
  for (const t of toc.value) {
    const el = document.getElementById(t.id);
    if (el) tocObserver.observe(el);
  }
}

watch(
  () => route.params.slug,
  () => {
    progress.value = 0;
    activeHeading.value = '';
    window.scrollTo({ top: 0 });
    load();
  }
);

onMounted(() => {
  load();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  clearTimeout(shareClickTimer); // 取消延迟挂载（防卸载后仍添加监听泄漏）
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', onShareDocClick);
  tocObserver?.disconnect();
  removeJsonLd(); // 移除本文 JSON-LD，防与后续页面结构化数据叠加
  if (mobileTocOpen.value) unlockBodyScroll();
});
</script>

<style scoped>
.article-detail {
  padding-bottom: 40px;
}

/* ============ 加载骨架 ============ */
.sk-head {
  padding-bottom: 34px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 34px;
}

.sk-title {
  height: 30px;
  border-radius: 8px;
  margin-top: 16px;
}

.sk-cover {
  height: 300px;
  border-radius: var(--radius-lg);
  margin-bottom: 34px;
}

.sk-text {
  height: 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  width: 100%;
}

/* ============ 加载失败 ============ */
.load-error {
  text-align: center;
  padding: 90px 0;
  position: relative;
}

.le-float {
  position: absolute;
  font-family: Georgia, serif;
  font-size: 8rem;
  font-weight: 800;
  color: var(--accent);
  opacity: 0.07;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  pointer-events: none;
}

.le-code {
  font-family: Georgia, serif;
  font-size: 3.4rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
  margin-bottom: 10px;
}

.le-title {
  font-size: 1.2rem;
  font-weight: 750;
  margin-bottom: 8px;
}

.le-desc {
  font-size: 0.9rem;
  color: var(--text-3);
  margin-bottom: 26px;
}

.le-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

/* ============ 阅读进度条 ============ */
.progress-track {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 200;
  background: transparent;
  pointer-events: none;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 0 3px 3px 0;
  transform-origin: left center;
  transform: scaleX(var(--p, 0));
  transition: transform 0.1s linear;
  will-change: transform;
}

/* ============ 布局 ============ */
.detail-layout {
  display: flex;
  gap: 44px;
  align-items: flex-start;
  padding-top: 28px;
}

.detail-main {
  flex: 1;
  min-width: 0;
  max-width: var(--reading-w);
  background: color-mix(in srgb, var(--card) 86%, transparent);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 36px 40px 28px;
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(12px);
}

/* ============ 文章头 ============ */
.detail-head {
  padding-bottom: 32px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 34px;
}

.head-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 18px;
}

.head-cat {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cat);
  padding: 3px 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--cat) 10%, transparent);
}

.head-cat.muted {
  color: var(--text-3);
  background: none;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  padding: 0;
}

.head-pin {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--accent-deep);
  background: var(--accent-soft);
  padding: 3px 10px;
  border-radius: 5px;
}

/* 分享按钮 */
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  position: relative;
}

.share-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.share-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.share-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.share-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-2);
  padding: 6px;
  z-index: 30;
  min-width: 130px;
}

.share-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.88rem;
  color: var(--text-2);
  width: 100%;
  text-align: left;
  transition: all var(--dur) var(--ease);
  border: none;
  background: none;
  cursor: pointer;
}

.share-item:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.share-pop-enter-active,
.share-pop-leave-active {
  transition: all 0.18s var(--ease-out);
  transform-origin: top right;
}

.share-pop-enter-from,
.share-pop-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}

.detail-title {
  font-size: clamp(1.85rem, 4vw, 2.6rem);
  font-weight: 800;
  line-height: 1.28;
  letter-spacing: -0.035em;
  margin-bottom: 20px;
  position: relative;
  display: inline-block;
}

.detail-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 2px;
  height: 2px;
  width: 0;
  border-radius: 1px;
  background: var(--accent);
  transition: width 0.45s var(--ease-out);
}

.detail-title:hover::after {
  width: 100%;
}

.detail-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}

.dm-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.84rem;
  color: var(--text-2);
}

/* 评论数统计可点击：悬停反馈（滚动到评论区） */
.dm-item.dm-link {
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}

.dm-item.dm-link:hover {
  color: var(--accent);
}

.dm-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line);
  margin: 0 8px;
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.d-tag {
  font-size: 0.8rem;
  color: var(--text-2);
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  transition: all var(--dur) var(--ease);
}

.d-tag:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ============ 封面 ============ */
.detail-cover {
  margin: 0 0 40px;
  border-radius: 22px;
  overflow: hidden;
  box-shadow: var(--shadow-3);
  position: relative;
  background: var(--bg-soft);
}

.detail-cover img {
  width: 100%;
  max-height: 520px;
  min-height: 240px;
  object-fit: cover;
  animation: coverFadeIn 0.8s var(--ease-out) both;
}

@keyframes coverFadeIn {
  from { opacity: 0; transform: scale(1.015); }
  to { opacity: 1; transform: scale(1); }
}

/* 封面加载失败兜底 */
.cover-err {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  background: var(--bg-soft);
}

.detail-cover.cover-failed .cover-err {
  display: flex;
}

.detail-cover.cover-failed img {
  display: none;
}

/* ============ 正文 ============ */
.detail-content {
  padding-bottom: 40px;
}

.decrypt-fail {
  padding: 28px 20px;
  border-radius: 16px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  text-align: center;
  font-weight: 600;
}

/* 阅读工具栏：字号调节 */
.reading-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--border);
}

.rt-label {
  font-size: 0.78rem;
  color: var(--text-3);
  margin-right: 4px;
}

.rt-btn {
  width: 34px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.95rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.rt-btn:hover:not(.dim) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.rt-btn.dim {
  opacity: 0.35;
  cursor: not-allowed;
}

.rt-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 6px;
}

.rt-btn.rt-wide {
  width: auto;
  padding: 0 12px;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* 衬线阅读模式 */
.markdown-body.serif {
  font-family: var(--font-serif);
}

.markdown-body.serif p,
.markdown-body.serif li {
  letter-spacing: 0.015em;
}

/* ============ 移动端悬浮按钮与目录抽屉 ============ */
.float-actions {
  position: fixed;
  right: 18px;
  bottom: calc(24px + env(safe-area-inset-bottom, 0px)); /* iOS 全面屏底部指示条避让 */
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fab {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  box-shadow: var(--shadow-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
  backdrop-filter: blur(8px);
}

.fab:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: translateY(-2px);
}

/* 点赞态与数字徽标 */
.fab.liked {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.fab-num {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.fab {
  position: relative;
}

.toc-mask {
  position: fixed;
  inset: 0;
  z-index: 350;
  background: rgba(15, 12, 9, 0.5);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
}

.toc-drawer {
  width: min(300px, 84vw);
  height: 100%;
  background: var(--card);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 18px;
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.2);
}

.td-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.td-title {
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.td-close {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur) var(--ease);
}

.td-close:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: rotate(90deg);
}

.td-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-soft);
  overflow: hidden;
  margin-bottom: 16px;
}

.td-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.1s linear;
}

.td-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 4px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); /* iOS 指示条避让 */
}

.td-item {
  display: block;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--text-2);
  border-left: 2px solid transparent;
  transition: all var(--dur) var(--ease);
}

.td-item.lvl-3 {
  padding-left: 26px;
  font-size: 0.85rem;
}

.td-item.lvl-4 {
  padding-left: 40px;
  font-size: 0.82rem;
}

.td-item:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.td-item.active {
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-soft);
  font-weight: 650;
}

.toc-mask-enter-active,
.toc-mask-leave-active {
  transition: opacity 0.22s var(--ease-out);
}

.toc-mask-enter-active .toc-drawer,
.toc-mask-leave-active .toc-drawer {
  transition: transform 0.26s var(--ease-out);
}

.toc-mask-enter-from,
.toc-mask-leave-to {
  opacity: 0;
}

.toc-mask-enter-from .toc-drawer,
.toc-mask-leave-to .toc-drawer {
  transform: translateX(100%);
}

@media (min-width: 1100px) {
  .float-actions {
    display: none;
  }
}

/* 点赞 */
.like-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-top: 52px;
  padding-top: 36px;
  border-top: 1px dashed var(--border);
}

.like-btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 12px 36px;
  border-radius: 999px;
  border: 1.5px solid var(--accent);
  color: var(--accent);
  font-size: 1.05rem;
  font-weight: 650;
  transition: all var(--dur) var(--ease);
}

.like-btn:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
  transform: translateY(-2px);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 30%, transparent);
}

.like-btn.liked {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.like-btn.liked .heart {
  display: inline-flex;
  animation: heartBeat 0.55s var(--ease-out);
}

@keyframes heartBeat {
  0% { transform: scale(1); }
  30% { transform: scale(1.28); }
  55% { transform: scale(0.92); }
  75% { transform: scale(1.12); }
  100% { transform: scale(1); }
}

.like-btn:disabled {
  cursor: default;
}

.like-hint {
  font-size: 0.82rem;
  color: var(--text-3);
}

/* ============ 上一篇/下一篇 ============ */
.neighbors {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin: 8px 0 44px;
}

/* 版权声明 */
.copyright-card {
  padding: 18px 24px;
  margin-bottom: 28px;
  background: var(--bg-soft);
  border-color: var(--border);
}

.cc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text-2);
}

.cc-title {
  font-weight: 700;
  font-size: 0.92rem;
}

.cc-text {
  font-size: 0.86rem;
  color: var(--text-2);
  line-height: 1.8;
  margin-bottom: 12px;
}

.cc-text a {
  color: var(--accent);
  border-bottom: 1px dashed var(--accent);
}

.cc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.cc-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.82rem;
  transition: all var(--dur) var(--ease);
}

.cc-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.cc-url {
  font-size: 0.76rem;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.nb-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px 22px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: all var(--dur) var(--ease);
}

.nb-card:hover:not(.empty) {
  border-color: var(--accent);
  box-shadow: var(--shadow-1);
}

.nb-card.next {
  align-items: flex-end;
  text-align: right;
}

.nb-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
  color: var(--text-3);
}

.nb-title {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nb-title.muted {
  color: var(--text-3);
  font-weight: 400;
}

/* ============ 相关文章 ============ */
.related-block {
  margin-bottom: 44px;
}

.related-title {
  font-size: 1.1rem;
  font-weight: 750;
  margin-bottom: 16px;
  padding-left: 12px;
  border-left: 3px solid var(--accent);
}

.related-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.related-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  transition: all var(--dur) var(--ease);
}

.related-card:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-1);
  transform: translateY(-2px);
}

.rc-bar {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  flex-shrink: 0;
}

/* 相关阅读封面缩略图（无封面时回退色条） */
.rc-cover {
  width: 64px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 8px;
  background-size: cover;
  background-position: center;
  background-color: var(--bg-soft);
}

.rc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rc-title {
  font-size: 0.92rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}

.related-card:hover .rc-title {
  color: var(--accent);
}

.rc-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76rem;
  color: var(--text-3);
}

.rc-arrow {
  color: var(--text-3);
  opacity: 0;
  transform: translate(-4px, 4px);
  transition: all var(--dur) var(--ease);
  flex-shrink: 0;
}

.related-card:hover .rc-arrow {
  opacity: 1;
  transform: none;
  color: var(--accent);
}

/* ============ 评论 ============ */
.comments {
  padding-top: 12px;
}

/* 评论关闭提示 */
.comments-disabled {
  padding: 40px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--text-3);
  font-size: 0.92rem;
}

/* ============ TOC 侧栏 ============ */
.detail-side {
  width: 236px;
  position: sticky;
  top: calc(var(--nav-h) + 28px);
  flex-shrink: 0;
  display: none;
}

.toc-box {
  border-left: none;
  padding: 16px 14px;
  background: color-mix(in srgb, var(--card) 80%, transparent);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(12px);
}

.toc-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  margin-bottom: 14px;
  transition: color var(--dur) var(--ease);
}

.toc-toggle:hover {
  color: var(--accent);
}

.toc-title {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}

.toc-chev {
  color: var(--text-3);
  transition: transform var(--dur) var(--ease);
}

.toc-collapse-enter-active,
.toc-collapse-leave-active {
  transition: all 0.22s var(--ease-out);
  overflow: hidden;
}

.toc-collapse-enter-from,
.toc-collapse-leave-to {
  opacity: 0;
  max-height: 0;
}

.toc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: calc(100vh - 180px);
  max-height: calc(100dvh - 180px);
  overflow-y: auto;
}

.toc-item {
  display: block;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.84rem;
  color: var(--text-2);
  border-left: 2px solid transparent;
  margin-left: -21px;
  transition: all var(--dur) var(--ease);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc-item.lvl-3 {
  padding-left: 24px;
}

.toc-item.lvl-4 {
  padding-left: 38px;
}

.toc-item:hover {
  color: var(--text);
  background: var(--bg-soft);
}

.toc-item.active {
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

/* 阅读进度小卡 */
.read-progress-box {
  margin-top: 24px;
  padding-left: 20px;
  border-left: 1px solid var(--border);
}

.rp-label {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 10px;
}

.rp-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-soft);
  overflow: hidden;
  margin-bottom: 8px;
}

.rp-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #c9900f));
  transition: width 0.1s linear;
}

.rp-percent {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
}

@media (min-width: 1100px) {
  .detail-side {
    display: block;
  }
}

/* ============ 响应式 ============ */
@media (max-width: 640px) {
  .detail-layout {
    padding-top: 24px;
  }
  .detail-main {
    padding: 22px 16px 18px;
    border-radius: 16px;
  }
  .detail-head {
    padding-bottom: 24px;
    margin-bottom: 26px;
  }
  .neighbors {
    grid-template-columns: 1fr;
  }
  .nb-card.next {
    align-items: flex-start;
    text-align: left;
  }
  .related-grid {
    grid-template-columns: 1fr;
  }
}
</style>
