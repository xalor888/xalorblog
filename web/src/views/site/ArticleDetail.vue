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
                :aria-label="bookmarked ? '取消收藏' : '收藏本文'"
                :aria-pressed="bookmarked ? 'true' : 'false'"
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
              <button class="share-btn" title="打印本文" aria-label="打印本文" @click="printPage">
                <XIcon name="Printer" :size="15" />
              </button>
              <button class="share-btn" title="分享" aria-label="分享" @click="openShare">
                <XIcon name="Share2" :size="15" />
              </button>
              <transition name="share-pop">
                <div v-if="shareMenu" class="share-menu">
                  <a :href="`https://service.weibo.com/share/share.php?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener noreferrer" class="share-item">
                    <XIcon name="AtSign" :size="15" /> 微博
                  </a>
                  <a :href="`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener noreferrer" class="share-item">
                    <XIcon name="Twitter" :size="15" /> Twitter
                  </a>
                  <a :href="`https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener noreferrer" class="share-item">
                    <XIcon name="Share2" :size="15" /> QQ 空间
                  </a>
                  <a :href="`https://www.zhihu.com/share?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener noreferrer" class="share-item">
                    <XIcon name="MessageCircleHeart" :size="15" /> 知乎
                  </a>
                  <a :href="`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(article.title)}`" target="_blank" rel="noopener noreferrer" class="share-item">
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
            <span class="dm-item"><XIcon name="Calendar" :size="14" /> {{ formatDate(article.published_at) || '未标注日期' }}</span>
            <span class="dm-item"><XIcon name="Clock" :size="14" /> {{ readingTime(article.content) }} 分钟</span>
            <span class="dm-sep"></span>
            <span class="dm-item"><XIcon name="FileText" :size="14" /> {{ wordCount }} 字</span>
            <span class="dm-sep"></span>
            <span class="dm-item"><XIcon name="Eye" :size="14" /> {{ formatNumber(article.views) }} 阅读</span>
            <span class="dm-sep"></span>
            <!-- 原来是 span + @click：鼠标能点，键盘与读屏完全到不了。
                 用原生 button 而不是 role+tabindex，省掉自己维护 Enter/Space 分支。 -->
            <button
              type="button"
              class="dm-item dm-link"
              title="跳到评论区"
              aria-label="跳到评论区"
              @click="scrollToComments"
            >
              <XIcon name="MessageSquare" :size="14" /> {{ article.comment_count }} 评论
            </button>
          </div>

          <div v-if="article.tags && article.tags.length" class="detail-tags">
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
        <!-- 沉浸开关单独留在外面：它是最常用的一项，不该藏在「阅读设置」里 -->
        <div class="reading-toolbar" :class="{ expanded: toolbarExpanded }">
          <button
            class="rt-btn rt-wide rt-focus"
            :class="{ on: focusMode }"
            @click="toggleFocusMode"
            :title="focusMode ? '退出沉浸阅读' : '沉浸阅读（隐藏导航与侧栏）'"
            :aria-pressed="focusMode"
          >
            <XIcon name="Maximize2" :size="13" />
            <span class="rt-focus-text">{{ focusMode ? '退出沉浸' : '沉浸' }}</span>
          </button>

          <!-- 手机：一个 Aa 按钮展开/收起全部阅读设置。
               实测 390px 宽放不下 11 个控件（需要 463px，只有 324px），
               硬挤会变成 3 行、把正文压掉 121px。桌面端这个按钮隐藏、设置常显。 -->
          <button
            class="rt-btn rt-wide rt-toggle"
            :class="{ on: toolbarExpanded }"
            @click="toolbarExpanded = !toolbarExpanded"
            :aria-expanded="toolbarExpanded"
            :title="toolbarExpanded ? '收起阅读设置' : '阅读设置（字号 / 行距 / 版心 / 字体）'"
          >
            <XIcon name="Settings2" :size="13" /> Aa
          </button>

          <div class="rt-group">
            <span class="rt-group-label">字体</span>
            <button class="rt-btn rt-wide" @click="toggleFontStyle" :title="fontStyle === 'serif' ? '切换到无衬线字体' : '切换到衬线字体'">
              {{ fontStyle === 'serif' ? '衬线' : '无衬线' }}
            </button>
          </div>

          <div class="rt-group">
            <span class="rt-group-label">字号</span>
            <button class="rt-btn" :class="{ dim: fontSize <= FONT_SIZE.min }" @click="changeFontSize(-1)" title="减小字号" aria-label="减小字号">A−</button>
            <span class="rt-value">{{ fontSize }}</span>
            <button class="rt-btn" :class="{ dim: fontSize >= FONT_SIZE.max }" @click="changeFontSize(1)" title="增大字号" aria-label="增大字号">A+</button>
          </div>

          <div class="rt-group">
            <span class="rt-group-label">行距</span>
            <button class="rt-btn" :class="{ dim: lineHeight <= LINE_HEIGHT.min }" @click="changeLineHeight(-1)" title="收紧行距" aria-label="收紧行距">
              <XIcon name="AlignJustify" :size="13" />
            </button>
            <span class="rt-value">{{ lineHeight.toFixed(2) }}</span>
            <button class="rt-btn" :class="{ dim: lineHeight >= LINE_HEIGHT.max }" @click="changeLineHeight(1)" title="放宽行距" aria-label="放宽行距">
              <XIcon name="AlignLeft" :size="13" />
            </button>
          </div>

          <div class="rt-group">
            <span class="rt-group-label">版心</span>
            <button class="rt-btn" :class="{ dim: readWidth <= READ_WIDTH.min }" @click="changeReadWidth(-1)" title="收窄版心" aria-label="收窄版心">窄</button>
            <span class="rt-value rt-narrow" :title="`每行约 ${charsPerLineValue} 字`">{{ charsPerLineValue }}字</span>
            <button class="rt-btn" :class="{ dim: readWidth >= READ_WIDTH.max }" @click="changeReadWidth(1)" title="放宽版心" aria-label="放宽版心">宽</button>
          </div>
        </div>
        <div v-if="article.content_decrypt_failed" class="decrypt-fail">
          正文解密失败，请刷新页面后重试。
        </div>
        <div
          v-else
          class="markdown-body"
          :class="{ serif: fontStyle === 'serif' }"
          v-html="renderedContent"
          :style="{ fontSize: fontSize + 'px', lineHeight: String(lineHeight), maxWidth: readWidth + 'px' }"
          @click="onContentClick"
        ></div>

        <!-- 点赞 -->
        <div class="like-zone">
          <button class="like-btn" :class="{ liked }" @click="doLike" :disabled="liked">
            <span class="heart">
              <XIcon name="Heart" :size="20" :fill="liked" :stroke-width="liked ? 0 : 1.8" />
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
            <a :href="ccLicenseUrl" target="_blank" rel="noopener noreferrer">署名-非商业性使用 4.0 国际 (CC BY-NC 4.0)</a>
            协议。转载请注明出处及原文链接。
          </p>
          <div class="cc-actions">
            <button class="cc-btn" @click="copyLink"><XIcon name="Link" :size="13" /> 复制本文链接</button>
            <span class="cc-url">{{ pageUrl }}</span>
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
          <!-- h2 而不是 h3：正文标题是 h1（markdown 里的层级由 v-html 内部自管），
                 从 h1 直接跳到 h3 属于层级跳级 —— 读屏用户按标题导航时会以为中间漏了一级。
                 这里样式由 .related-title 控制，与标签名无关，改标签不影响外观。 -->
            <h2 class="related-title">相关阅读</h2>
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

      <!-- 文章页补充按钮（跳评论 / 目录）——点赞在文末、回顶用全局那个（带进度环），不重复。
           并进右下角浮层栈（#float-dock），不再自己 fixed 定位，避免与全局工具条堆叠 -->
      <Teleport to="#float-dock">
        <div v-if="article" class="float-actions">
          <button v-if="article?.allow_comment !== false" class="dock-btn fab" title="跳到评论区" aria-label="跳到评论区" @click="scrollToComments">
            <XIcon name="MessageSquare" :size="18" />
            <span v-if="article?.comment_count" class="fab-num">{{ article.comment_count }}</span>
          </button>
          <button v-if="toc.length" class="dock-btn fab" title="打开目录" aria-label="打开目录" @click="mobileTocOpen = true">
            <XIcon name="ListTree" :size="18" />
          </button>
        </div>
      </Teleport>

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

    <!-- 上次阅读位置已恢复：给一条可关闭的说明 + 一键跳回开头。
         不给提示的话，读者一进来就在文中，会以为文章开头丢了。 -->
    <transition name="rp-toast">
      <div v-if="restoredPos" class="restore-tip" role="status">
        <span>已回到上次读到的位置</span>
        <button type="button" class="restore-top" @click="backToTop">回到开头</button>
      </div>
    </transition>

    <!-- 读者问答：仅在被 gate 放行且站点配了模型时出现（组件内部自查） -->
    <AskAi v-if="article && article.slug" :slug="article.slug" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import XIcon from '@/components/ui/XIcon.vue';
import ImageLightbox from '@/components/ui/ImageLightbox.vue';
import CommentSection from '@/components/site/CommentSection.vue';
import AskAi from '@/components/site/AskAi.vue';
import { articleApi } from '@/api';
import { renderMarkdown, extractToc, addHeadingIds, addImgAttrs } from '@/utils/markdown';
import { formatDate, formatNumber, readingTime } from '@/utils/format';
import { isBookmarked, addBookmark, removeBookmark, onBookmarksChange } from '@/utils/bookmark';
import { addHistory } from '@/utils/history';
import { useSiteStore } from '@/stores/site';
import { lockBodyScroll, unlockBodyScroll } from '@/utils/scrollLock';
import { setArticleCopyAllowed, clearArticleCopyScope } from '@/utils/copyGuard';
import { downloadBlob } from '@/utils/download';
import { applyPageMeta, siteOrigin, clearPageJsonLd } from '@/utils/pageMeta';
import {
  FONT_SIZE,
  LINE_HEIGHT,
  READ_WIDTH,
  loadFontSize,
  loadLineHeight,
  loadReadWidth,
  loadFontStyle,
  loadFocusMode,
  stepFontSize,
  stepLineHeight,
  stepReadWidth,
  saveFontSize,
  saveLineHeight,
  saveReadWidth,
  saveFontStyle,
  saveFocusMode,
  charsPerLine,
} from '@/utils/readingPrefs';

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
/** 刚恢复了上次阅读位置：显示一条可关闭的提示 */
const restoredPos = ref(false);
const shareMenu = ref(false);
// 目录折叠偏好记忆（多数读者习惯固定展开/收起）
const tocCollapsed = ref((() => {
  try { return localStorage.getItem('xalor_toc_collapsed') === '1'; } catch (e) { return false; }
})());
function toggleToc() {
  tocCollapsed.value = !tocCollapsed.value;
  try {
    localStorage.setItem('xalor_toc_collapsed', tocCollapsed.value ? '1' : '0');
  } catch (e) { /* 隐私模式忽略 */ }
}
/* 阅读偏好统一走 utils/readingPrefs：坏值（''、'abc'、越界、旧版大小写）
   在那一层就被夹成合法值，绝不会把 `font-size: NaNpx` 灌进行内样式。 */
const fontSize = ref(loadFontSize(localStorage));
const lineHeight = ref(loadLineHeight(localStorage));
const readWidth = ref(loadReadWidth(localStorage));
const fontStyle = ref(loadFontStyle(localStorage));
const focusMode = ref(loadFocusMode(localStorage));
/* 手机上「阅读设置」的展开态。默认收起——没人愿意为了读一篇文章
   先看 11 个控件；桌面端这一组永远展开，这个状态不参与。 */
const toolbarExpanded = ref(false);
/** 每行字数：给「版心」一个可读的反馈，而不是只有像素数字 */
const charsPerLineValue = computed(() => charsPerLine(readWidth.value, fontSize.value));
const mobileTocOpen = ref(false);
const lightboxRef = ref(null);

/** 从图片 URL 推一个能念的名字：/uploads/2026/knex-join.png → knex join */
function fileNameFromSrc(src) {
  try {
    const raw = String(src || '').split(/[?#]/)[0];
    const name = decodeURIComponent(raw.split('/').pop() || '');
    return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 60);
  } catch (e) {
    return '';
  }
}
const bookmarked = ref(false);
let offBookmarkSync = null;

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
    // alt 优先；缺 alt 时用 addImgAttrs 兜底的 aria-label（文件名）。
    //
    // 最后一级兜底是必须的：`alt=""` 在正文里表示「装饰图，读屏跳过」，
    // 这是对的（addImgAttrs 有意不给空 alt 补标签）。但**用户主动点开大图**，
    // 说明它不是装饰 —— 此时灯箱只有一句「查看大图」，
    // 读屏用户不知道自己在看什么。实测空 alt 的图打开后 aria-label 就是「查看大图」。
    // 用文件名兜底，至少能说出这是哪张图。
    const caption = img.alt || img.getAttribute('aria-label') || fileNameFromSrc(img.src);
    lightboxRef.value?.open(img.src, caption, img);
  }
}

/** 字号 / 行距 / 版心：统一走 readingPrefs 的夹取与步进，到边界停住 */
function changeFontSize(delta) {
  fontSize.value = stepFontSize(fontSize.value, delta);
  saveFontSize(localStorage, fontSize.value);
}

function changeLineHeight(delta) {
  lineHeight.value = stepLineHeight(lineHeight.value, delta);
  saveLineHeight(localStorage, lineHeight.value);
}

function changeReadWidth(delta) {
  readWidth.value = stepReadWidth(readWidth.value, delta);
  saveReadWidth(localStorage, readWidth.value);
}

/** 正文字体风格切换（无衬线/衬线，localStorage 记忆） */
function toggleFontStyle() {
  fontStyle.value = fontStyle.value === 'serif' ? 'sans' : 'serif';
  saveFontStyle(localStorage, fontStyle.value);
}

/**
 * 沉浸阅读：给 <html> 挂 data-focus。
 * 用 documentElement 而不是本组件根节点，是因为导航、页脚、浮层栈
 * 都在 Layout 里（浮层栈还 teleport 到了 #app 之外的 #float-dock），
 * 组件内部的选择器一个都够不到。
 */
function toggleFocusMode() {
  focusMode.value = !focusMode.value;
  saveFocusMode(localStorage, focusMode.value);
}

watch(focusMode, (on) => {
  document.documentElement.dataset.focus = on ? 'on' : '';
}, { immediate: true });

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
  if (!article.value || !article.value.content) return 0;
  const cn = (article.value.content.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (article.value.content.match(/[a-zA-Z0-9]+/g) || []).length;
  return cn + en;
});

// 下面两个地址都走 pageMeta 的 siteOrigin（不是手写字符串拼接）：
// 后台把 site_url 填成裸域名（`xalor.cn`）时，手拼会漏掉协议 ——
// `xalor.cn/api/share/x` 在社交平台与「复制链接」里都是废地址。

/** 版权区 / 复制链接展示的 SPA 文章地址（也是 og:url 的来源） */
const pageUrl = computed(() => {
  if (!article.value) return '';
  const base = siteOrigin(site);
  return `${base}/#/article/${article.value.slug}`;
});

/** 给爬虫抓 OG 的分享页（= canonical 指向的收录目标）；分享按钮也用它 */
const shareUrl = computed(() => {
  if (!article.value) return '';
  const base = siteOrigin(site);
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
  /**
   * 复制**干净的**文章地址，而不是 window.location.href。
   *
   * 为什么：href 里会带着读者进来时的全部 query ——
   * 缓存击穿参数、渠道来源（?from=wechat）、utm 之类。
   * 实测复制出来是 `.../?h=1792942176448#/article/xxx`：
   * 那次是测试加的，但真实场景里读者从任何带参链接进来都一样。
   * 转发给别人时那串数字没有任何用处，还让人以为链接坏了或带追踪。
   *
   * 做法：只保留 origin + pathname + hash（hash 里是路由，必须留）。
   */
  const url = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => ElMessage.success('链接已复制'))
      .catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
  shareMenu.value = false;
  document.removeEventListener('click', onShareDocClick);
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    ElMessage.success('链接已复制');
  } catch (e) {
    ElMessage.warning('复制失败，请手动长按或选中地址栏复制');
  }
}

/** 打印：模板作用域拿不到 window 全局，必须经函数转发（window.print() 直接写在模板里会抛错） */
function printPage() {
  window.print();
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
    a.summary ? `> ${a.summary}` : '',
  ].filter((line) => line !== '').join('\n');
  /**
   * 结尾必须留出分隔线 + 换行，正文才接得上。
   *
   * 原实现把 '---' 和 '' 也塞进数组再 filter 掉空串，于是
   * 分隔线与正文标题**粘成同一行**：实测导出文件里是
   * `---# 欢迎来到 Xalor 的小站 🎉` —— 这条分隔线失效，
   * 而且正文 Markdown 渲染出来会变成一个 setext 标题或直接吞掉。
   */
  /**
   * 正文里以 `# ` 开头的行降级为 `## `。
   *
   * 网页端有 demoteH1 做这件事（每页只能有一个 h1，由页面模板提供），
   * 但导出走的是另一条路 —— 实测导出的文件里 frontmatter 之后有一个
   * `# 标题`，正文自己还有一个 `# 欢迎来到 Xalor 的小站 🎉`，
   * **同一个文件里两个 h1**。导入到别的工具时大纲会错乱。
   */
  const body = String(a.content || '').replace(/^# (?!#)/gm, '## ');
  const full = `${meta}\n\n---\n\n${body}`;
  const blob = new Blob([full], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `${a.slug || 'article'}.md`);
  ElMessage.success('Markdown 已导出');
}

const renderedContent = computed(() => {
  if (!article.value || !article.value.content) return '';
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
    // 本篇的复制开关（后台文章编辑页可改）；全站开关由 Layout 统一控制
    setArticleCopyAllowed(a.allow_copy);
    applyArticleMeta();
    toc.value = extractToc(a.content);
    // 深链直达某个小标题：别人分享 `#/article/slug#heading-2` 这类链接时，
    // hash 路由的二级 hash **不会被浏览器自动处理**（浏览器只认第一个 #）。
    // 实测：带着 `#heading-2` 进来时 scrollY 仍是 0、目标标题停在 top=1212 视口外，
    // 也就是说那个锚点在分享出去的那一刻就失效了。
    // 正文是异步取回的，所以必须等 DOM 渲染完（nextTick）再滚，否则元素还不存在。
    // 用 'auto' 而不是 smooth：首次进入时平滑滚动会从顶部划过整篇文章，很怪。
    const hashId = String(route.hash || '').replace(/^#/, '');
    if (hashId) {
      // ⚠ 只等一次 nextTick 不够：router 的 scrollBehavior 在导航收尾时
      // `return { top: 0 }` 会把页面**再滚回顶部**，和我们这次滚动打架 ——
      // 实测一次 nextTick 时好时坏（同一批四个锚点得到 42 / 344 / 74 / 74 四种位置）。
      // 所以要跨过 router 的这一次重置：先等 DOM，再让出一帧给导航收尾，然后才滚。
      nextTick(() => {
        requestAnimationFrame(() => {
          const el = document.getElementById(hashId);
          if (!el) return;
          el.focus({ preventScroll: true });
          el.scrollIntoView({ behavior: 'auto', block: 'start' });
        });
      });
    }
    liked.value = (() => {
      try { return !!localStorage.getItem(`xalor_liked_${a.id}`); } catch (e) { return false; }
    })();
    bookmarked.value = isBookmarked(a.id);
    // 记一条阅读足迹（本机、被动、滚动淘汰）。放在取到正文之后，
    // 这样记下的是**真的读到过**的文章，而不是点进来又立刻退出的。
    addHistory(a);
    // 另一个标签页取消/新增收藏时，这里的按钮也要跟着变。
    // 不监听的话：那边清空了，这边还写着「取消收藏」，再点一下反而把它收回来。
    if (!offBookmarkSync) {
      offBookmarkSync = onBookmarksChange(() => {
        if (article.value) bookmarked.value = isBookmarked(article.value.id);
      });
    }
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
    // 内容排好之后再恢复阅读位置（否则此时文档高度还不完整，比例算出来是错的）
    if (restoreScroll()) {
      restoredPos.value = true;
      // 提示条 6 秒后自己消失，不打扰阅读
      setTimeout(() => { restoredPos.value = false; }, 6000);
      // 恢复后立刻同步一次进度/高亮，避免还停在 0%
      onScroll();
    }
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

/** 从「恢复的阅读位置」回到文章开头 */
function backToTop() {
  restoredPos.value = false;
  forgetScroll(route.params.slug);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 失败后重试 */
function retryLoad() {
  load();
}

/** 动态更新页面标题与分享元信息（SEO / 社交分享）
 *
 * 除了 document.title（pageMeta 明确不越权改 <title>），整组 head 写入都交给
 * utils/pageMeta.js —— 原来这里自建了 setMeta / setByName / applyJsonLd / canonical
 * 那一套，与列表页等页面共用的实现并存，于是两边各自漂移：
 *   缺 og:site_name；cover 没补协议（site_url 填裸域名时 og:image 成了相对路径，
 *   社交平台直接忽略 → 分享卡片没图）；canonicalUrl 与 shareUrl 还是两个逐字相同的
 *   computed（同一个值算两遍）。
 *
 * canonical 指向分享页（/api/share/:slug，真实 HTML，搜索引擎收录目标）；
 * og:url 仍是 SPA 文章页地址（人类的分享落点）—— 两者本来就该不同，所以分开传。
 */
function applyArticleMeta() {
  const a = article.value;
  if (!a) return;
  const name = site.settings.site_name || 'Xalor的小站';
  // pageMeta 只写 meta 标签，浏览器标签页标题在这里写
  document.title = `${a.title} · ${name}`;
  applyPageMeta({
    title: a.title,
    description: a.summary || a.title,
    // og:url：SPA 文章页；'#' 之后的部分由 absoluteUrl 原样保留
    path: `/#/article/${a.slug}`,
    // canonical：服务端分享页，与 /api/share/:slug 自己输出的那一份完全一致
    canonical: shareUrl.value,
    // 有封面用封面，没有则由 pageMeta 退回站点默认图 /og-image.png；
    // 两者都由它绝对化并补齐协议（cover 是相对路径时也能用）
    image: a.cover || '',
    site,
    type: 'article',
    jsonLd: buildJsonLd(a),
  });
}

/** BlogPosting 结构化数据（富摘要/知识图谱收录）；真正写进 <head> 的是 pageMeta */
function buildJsonLd(a) {
  const s = site.settings;
  const name = s.site_name || 'Xalor的小站';
  const author = s.author || s.nickname || name;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: a.title,
    description: (a.summary || a.title).slice(0, 200),
    mainEntityOfPage: { '@type': 'WebPage', '@id': shareUrl.value },
    author: { '@type': 'Person', name: author },
    publisher: { '@type': 'Organization', name, logo: s.avatar ? { '@type': 'ImageObject', url: s.avatar } : undefined },
    image: a.cover || s.avatar || undefined,
  };
  /**
   * 日期字段单独条件赋值：清空发布时间后 a.published_at 是 null，
   * 而 `null` 会被 JSON.stringify 保留（只有 undefined 才会被丢弃）——
   * 结构化数据里出现 "datePublished": null 是**无效声明**，Google 会判整条不合法，
   * 而不是忽略这一个字段。所以「没有值」时宁可不写这个键。
   */
  if (a.published_at) ld.datePublished = a.published_at;
  if (a.updated_at || a.published_at) ld.dateModified = a.updated_at || a.published_at;
  if (Array.isArray(a.tags) && a.tags.length) ld.keywords = a.tags.map((t) => t.name).join(', ');
  return ld;
}

async function doLike() {
  if (liked.value) return;
  try {
    const res = await articleApi.like(article.value.id);
    article.value.likes = res.likes;
    liked.value = true;
    try {
      localStorage.setItem(`xalor_liked_${article.value.id}`, '1');
    } catch (e) { /* 隐私模式忽略 */ }
    ElMessage.success('感谢点赞 ❤️');
  } catch (e) {
    /* 拦截器已提示 */
  }
}

/**
 * 目录跳转到某个标题。
 *
 * 为什么不能只 scrollIntoView：实测点目录后焦点会掉到 body ——
 * 滚动发生了，但键盘用户和读屏都不知道「现在到了哪一节」，
 * 下一次 Tab 会从页面顶部重新开始，人等于被扔回起点。
 * 所以：滚动 + 把焦点送到目标标题（标题带 tabindex="-1"，可脚本聚焦）。
 * 用 preventScroll 再手滚，避免 focus 的默认滚动和 smooth 冲突。
 */
function scrollToHeading(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/**
 * 阅读进度的基准是**正文结束**，不是整页结束。
 *
 * 为什么：原实现用 `scrollHeight - innerHeight` 当分母，
 * 而本页正文之后还有约 1848px 的页脚 / 版权 / 上下篇导航（占整页 64%）。
 * 实测**读者读完正文那一刻，进度只有 36.2%** —— 读完了却显示才读三分之一，
 * 这个数字是错的，而且会让人以为文章还长着。
 *
 * 现在的分母是「正文末尾到视口顶部」的距离：
 * - 正文末尾进入视口（即读者看到最后一行）时 = 100%；
 * - 正文再短也不跳变：`Math.min(100, ...)` 兜住。
 * 滚过正文之后（页脚、推荐）进度保持在 100%，符合「读完了」的直觉。
 */
function computeReadingProgress() {
  const body = document.querySelector('.markdown-body');
  if (!body) {
    // 正文还没渲染出来（首屏加载中）：退回整页算法，避免突然跳到 0
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0;
  }
  const bodyBottom = body.getBoundingClientRect().bottom + window.scrollY;
  // 读者看到正文最后一行时的 scrollY
  const endScroll = bodyBottom - window.innerHeight;
  if (endScroll <= 0) return 100; // 正文一屏就放得下，视为已读完
  return Math.max(0, Math.min(100, (window.scrollY / endScroll) * 100));
}

/**
 * 阅读位置记忆。
 *
 * 为什么要有：实测读完一半离开、再回来，滚动位置回到 0 ——
 * 长文读者每次都得重新找位置。正文页最该记住的东西就是这个。
 *
 * 实现要点：
 * - 以 `slug` 为键，每篇独立；
 * - 记录的是**归一化比例**（0~1）而不是像素：字号、窗口宽度、图片加载
 *   都会改变文档总高度，存像素回来就偏了；
 * - 写 localStorage 走 500ms 节流 —— scroll 每帧都可能触发，
 *   逐帧写会明显拖慢长文滚动；
 * - 读回来时**只在「刚加载完、还没滚动过」时应用一次**，
 *   否则用户自己滚回去会被旧位置抢走。
 */
const SCROLL_KEY_PREFIX = 'xalor_readpos_';
let lastScrollSave = 0;

function rememberScroll() {
  const slug = route.params.slug;
  if (!slug) return;
  const now = Date.now();
  // ⚠ 首次滚动必须立刻写，不能让它等节流窗口。
  // 实测：用滚动条一次性拖到中间只触发**一次** scroll 事件，
  // 而那时 lastScrollSave 还没到 500ms 窗口 → 位置根本没存下来，
  // 回到页面时仍是 0。真实用户拖滚动条就是这么操作的。
  // 所以 lastScrollSave 为 0（本次进来还没存过）时跳过节流判断。
  if (lastScrollSave && now - lastScrollSave < 500) return;
  lastScrollSave = now;
  // ⚠ 比例的分母必须是**正文可滚动区间**，不是整页。
  // 用整页时：正文之后还有页脚和推荐，比例会偏小，恢复位置落不到原文处。
  // （实测离开时 41%，回到的位置却在正文之外。）
  // 这与阅读进度用同一套基准（computeReadingProgress），两处口径一致。
  const endScroll = contentEndScroll();
  // 太靠上或已经读完：都不值得记，下次从头开始更符合预期
  if (endScroll <= 0 || window.scrollY < endScroll * 0.03 || window.scrollY >= endScroll * 0.98) {
    forgetScroll(slug);
    return;
  }
  try {
    localStorage.setItem(SCROLL_KEY_PREFIX + slug, String(window.scrollY / endScroll));
  } catch (e) { /* 隐私模式/配额满：静默忽略，不影响阅读 */ }
}

/** 正文末尾滚到视口顶部所需的位置：阅读进度与位置记忆共用的基准 */
function contentEndScroll() {
  const body = document.querySelector('.markdown-body');
  if (!body) return document.documentElement.scrollHeight - window.innerHeight;
  return body.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
}

function forgetScroll(slug) {
  try {
    localStorage.removeItem(SCROLL_KEY_PREFIX + slug);
  } catch (e) { /* 同上 */ }
}

/** 恢复上次位置。返回是否真的恢复了，供调用方决定要不要聚焦正文。 */
function restoreScroll() {
  const slug = route.params.slug;
  if (!slug) return false;
  let ratio = 0;
  try {
    ratio = parseFloat(localStorage.getItem(SCROLL_KEY_PREFIX + slug) || '0');
  } catch (e) {
    return false;
  }
  if (!(ratio > 0.03 && ratio < 0.98)) return false; // 底部位置也不值得恢复
  const endScroll = contentEndScroll();
  if (endScroll <= 0) return false;
  // 用 instant 而不是 smooth：恢复位置是「回到原处」，不是一段动画
  window.scrollTo({ top: Math.round(endScroll * ratio), behavior: 'auto' });
  return true;
}

/** 滚动监听：阅读进度（rAF 节流）+ TOC 高亮由 IntersectionObserver 负责 */
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    progress.value = computeReadingProgress();
    syncActiveHeading();
    rememberScroll();
    ticking = false;
  });
}

/**
 * TOC 高亮：IntersectionObserver 观察标题（比 scroll 轮询高效，
 * 浏览器自动节流，无需每帧 getBoundingClientRect 遍历）
 */
let tocObserver = null;

/**
 * 把当前高亮项滚进目录自身的可视区。
 *
 * 为什么不能省：`.toc-list` 有 `max-height` + `overflow-y: auto`，长文时目录是
 * 一个独立滚动区。正文往下读，高亮项会一路走出这个小区间，读者就再也看不到
 * 「我现在在哪一节」—— 目录的全部价值就是这条跟随高亮。
 *
 * 用 `block: 'nearest'` 而不是 'center'：'nearest' 在元素已可见时**什么都不做**，
 * 不会因为每次高亮变化都把目录「吸」到中间来回晃。
 *
 * 为什么不传 `behavior: 'smooth'`：不传时按 CSS `scroll-behavior` 解析，而
 * `.toc-list` 上并没有设它（该属性不继承，`main.css` 里那条 smooth 在 `html` 上），
 * 所以这里是**瞬时**滚动。正文本来就在滚，目录再叠一段动画等于双重运动，
 * 读者会觉得目录在追着跑 —— 跟随动作越不显眼越好。
 * `prefers-reduced-motion` 下 `main.css` 另有 `scroll-behavior: auto !important` 兜底。
 */
let tocScrollTick = null;
function revealActiveTocItem() {
  if (tocScrollTick) return; // 同一帧内多次高亮变化只跟随一次
  tocScrollTick = requestAnimationFrame(() => {
    tocScrollTick = null;
    const el = document.querySelector('.toc-list .toc-item.active');
    if (!el) return;
    // 折叠状态下 `.toc-list` 不可见，硬滚会把 hidden 容器算成 0 高度、
    // 造成下次展开时位置错乱，所以直接跳过
    if (tocCollapsed.value) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/**
 * 计算「当前正在读的小节」：取最后一个已经越过激活线的标题。
 *
 * ⚠ 两条实现弯路都记在这里：
 * 1. 原来从 IntersectionObserver 的 entries 里选 —— 但 **entries 只含变化的元素**，
 *    于是几乎总只剩「刚进入的那个」，高亮永远领先一格（5 个标题错 4 个）。
 * 2. 改成「量所有标题」后仍有偏差：观察器只在**进入/离开视口**时触发，
 *    标题完全滚出视口后就不再回调，滚动到中间位置时高亮停在旧值。
 * 所以最终**不依赖观察器**，直接在 scroll 的 rAF 里算（本来就已节流）。
 */
function computeActiveHeading() {
  const line = 110; // 激活线：距视口顶部 110px
  let current = '';
  for (const t of toc.value) {
    const el = document.getElementById(t.id);
    if (!el) continue;
    if (el.getBoundingClientRect().top - line <= 0) current = t.id;
    else break; // 标题按文档顺序排列，后面的都还在下方
  }
  return current || (toc.value[0]?.id ?? '');
}

function syncActiveHeading() {
  const id = computeActiveHeading();
  if (id && activeHeading.value !== id) {
    activeHeading.value = id;
    revealActiveTocItem();
  }
}

function setupTocObserver() {
  tocObserver?.disconnect();
  tocObserver = new IntersectionObserver(
    () => {
      // ⚠ 不要用 entries 来选「当前章节」。
      //
      // 原实现从 entries 里过滤 isIntersecting 再取 rect.top 最小的那个 ——
      // 但 **entries 只包含本次发生变化的元素**，不是所有标题。
      // 于是几乎总只剩下「刚进入激活区的那一个」，结果高亮永远领先一格：
      // 实测滚到「为什么选 Knex」时高亮「基本用法」，
      // 滚到「基本用法」时高亮「进阶：动态查询」，5 个标题里错 4 个。
      // 甚至把标题精确停在激活区起点（top=110）也仍然错。
      //
      // 正确做法：每次回调都把**所有**标题的位置量一遍，
      // 取「最后一个已经越过激活线上方」的标题 —— 那才是读者正在看的小节。
      const line = 110; // 激活线：距视口顶部 110px
      let current = null;
      for (const t of toc.value) {
        const el = document.getElementById(t.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top - line <= 0) current = t.id; // 已经滚过去了
        else break; // 标题按文档顺序排列，后面的都还在下方
      }
      // 还没滚过第一个标题时，进度的起点就是第一项
      const id = current || (toc.value[0]?.id ?? '');
      if (id && activeHeading.value !== id) {
        activeHeading.value = id;
        revealActiveTocItem();
      }
    },
    // 观察范围放宽到整个视口：不需要「带状激活区」了，
    // 因为判断逻辑改成量所有标题的位置。
    { rootMargin: '0px', threshold: 0 }
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
  // 取消跨标签页收藏同步监听，避免组件卸载后闭包仍挂在 window 上
  if (offBookmarkSync) { offBookmarkSync(); offBookmarkSync = null; }
  clearTimeout(shareClickTimer); // 取消延迟挂载（防卸载后仍添加监听泄漏）
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', onShareDocClick);
  tocObserver?.disconnect();
  clearPageJsonLd(); // 移除本文 JSON-LD，防与后续页面结构化数据叠加（节点由 pageMeta 管）
  if (mobileTocOpen.value) unlockBodyScroll();
  clearArticleCopyScope(); // 离开文章页：复制限制回到只受全站开关控制
  // 沉浸状态挂在 <html> 上，不收尾会把「导航没了」带到首页
  document.documentElement.dataset.focus = '';
});
</script>

<style scoped>
.article-detail {
  padding-bottom: 40px;
}

/* 阅读位置恢复提示：固定在底部中央，不遮挡正文 */
.restore-tip {
  position: fixed;
  left: 50%;
  bottom: calc(24px + var(--sab, 0px));
  transform: translateX(-50%);
  z-index: calc(var(--z-nav) + 2);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px 10px 16px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 0.85rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  max-width: calc(100vw - 32px);
}

.restore-top {
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.restore-top:hover {
  background: var(--bg-soft);
  border-color: var(--accent);
}

.restore-top:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.rp-toast-enter-active,
.rp-toast-leave-active {
  transition: opacity 0.22s var(--ease), transform 0.22s var(--ease);
}

.rp-toast-enter-from,
.rp-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
  line-height: 1;
  margin-bottom: 10px;
}

.le-title {
  font-size: 1.2rem;
  font-weight: 750;
  margin-bottom: 8px;
  /* ⚠ 必须显式给颜色。
     原来这里没有 color，h2 于是继承到别处的浅色 ——
     实测浅色主题下「加载失败，请稍后重试」对比度只有 **1.18:1**（要求 3）。
     错误页正是用户最需要看清文字的时候，却成了全站对比度最差的地方。 */
  color: var(--text);
}

.le-desc {
  font-size: 0.9rem;
  /* --text-3 在浅色底上 5.34:1 合规（第 53 轮已确认），
     之前 3.56 是因为整块继承了错误页面的颜色上下文。显式声明。 */
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
  z-index: var(--z-float);
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
  background: color-mix(in srgb, var(--cat) 7%, transparent);
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
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.share-btn.active {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.share-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  /* 玻璃气泡：偏实，保证条目可读 */
  background: var(--lg-surface-pop);
  border: 1px solid var(--lg-edge);
  border-radius: var(--lg-radius-sm);
  box-shadow: var(--lg-inner), var(--lg-shadow-pop);
  backdrop-filter: var(--lg-blur-pop);
  -webkit-backdrop-filter: var(--lg-blur-pop);
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
  color: var(--accent-text);
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
  /* 标题是作者可控的：超长英文单词或长 URL 会横向撑破容器（字号 clamp 到 2.6rem，溢出更明显）。
     `overflow-wrap: anywhere` 只在「整串放不下」时才断，中文正常换行不受影响。 */
  overflow-wrap: anywhere;

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
  /* 其中「N 评论」已从 span 改成 button：必须清掉 UA 默认样式，
     否则会多出内边距、灰底和居中文字，把整行元信息排版撑歪。 */
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  flex-wrap: wrap;
  gap: 6px;
  /* 窄屏换行时行与行之间要给呼吸 */
  row-gap: 8px;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--border);
}

/* 「Aa」折叠按钮：桌面端不需要（设置本来就是一排常显的）。
   注意必须用 .rt-btn.rt-toggle (0,2,0)：单写 .rt-toggle (0,1,0) 与后面的
   .rt-btn (0,1,0) 同级，源码在前的会被后面的 display:flex 覆盖 —— 
   实测就是「桌面端 Aa 按钮一直显示」。 */
.rt-btn.rt-toggle {
  display: none;
}

/* ============ 窄屏：阅读设置折叠 ============
   实测 390px 宽的手机上，11 个控件一共要 463px，可用宽度只有 324px。
   硬挤的后果是工具栏变成 3 行 121px，正文被压掉一大截。
   所以窄屏只留「沉浸」+「Aa」两个按钮，其余四组收进 Aa 里按需展开。 */
@media (max-width: 720px) {
  .reading-toolbar {
    justify-content: flex-start;
    row-gap: 0;
  }
  .rt-btn.rt-toggle {
    display: inline-flex;
  }
  /* 收起态：除前两个按钮外全不渲染（display:none 不占位、不可聚焦） */
  .reading-toolbar:not(.expanded) .rt-group {
    display: none;
  }
  /* 展开态：整组换行，每组独占一行，依然比原来 11 个挤在一起清楚 */
  .reading-toolbar.expanded {
    row-gap: 8px;
  }
  .reading-toolbar.expanded .rt-group {
    flex: 1 1 100%;
    justify-content: flex-start;
  }
  .rt-btn {
    height: 32px;
  }
  .rt-group-label {
    min-width: 32px;
  }
}

/* 分组：每组内部紧邻、组与组之间留白，不再靠分隔线硬撑 */
.rt-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.rt-group-label {
  font-size: 0.78rem;
  color: var(--text-3);
  margin-right: 2px;
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
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.rt-btn.dim {
  opacity: 0.35;
  cursor: not-allowed;
}

.rt-btn.rt-wide {
  width: auto;
  padding: 0 12px;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  /* 图标 + 文字并排时居中对齐（沉浸 / 衬线 两个按钮） */
  gap: 5px;
}

/* 沉浸模式开关的激活态 */
.rt-btn.on {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 当前值（字号 / 行距 / 每行字数）：等宽数字，步进时不抖动 */
.rt-value {
  min-width: 30px;
  text-align: center;
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}

.rt-value.rt-narrow {
  min-width: 48px;
  color: var(--text-3);
}

/* 正文版心：默认走 token，用户调过之后由行内 maxWidth 覆盖。
   宽屏上每行几十字最舒服，超过 ~48 字容易串行。

   这里**故意不加 transition**：max-width 变化会触发整篇正文重新排版，
   过渡意味着每帧都重排一次上万字，调一次版心能掉到 20fps。
   版心是「设一下就不动」的参数，瞬间生效反而更像原生控件。 */
.detail-content .markdown-body {
  max-width: var(--reading-w);
  margin-left: auto;
  margin-right: auto;
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
/* 已在 #float-dock 这一列里排布，不再自己 fixed 定位 */
.float-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 基础几何与玻璃材质来自全局 .dock-btn（main.css），这里只保留差异态 */
.fab:hover {
  color: var(--accent-text);
  border-color: var(--accent);
  transform: translateY(-2px);
}

/* 点赞态与数字徽标 */
.fab.liked {
  color: var(--accent-text);
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
  background: var(--accent-fill);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.toc-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-scrim);
  background: rgba(15, 12, 9, 0.5);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
}

.toc-drawer {
  width: min(300px, 84vw);
  height: 100%;
  /* 液态玻璃抽屉：从右侧滑入的玻璃板 */
  background: var(--lg-sheen), var(--lg-surface);
  border-left: 1px solid var(--lg-edge);
  display: flex;
  flex-direction: column;
  /* 顶部让开刘海/灵动岛，底部让开 Home 指示条：抽屉是贴边全高的，
     不加这两项会把标题压在状态栏里、最后一项压在手势条下 */
  /* 四个方向都要让：原先只给了 上/右/下 三个值，**左侧用的是初始值** ——
     横屏时刘海在左边，抽屉左侧内容会被切掉。
     --sal 在 :root 里一直是定义好的，但全项目 `var(--sal)` 的使用次数是 0：
     定义了却没人用，等于没定义。 */
  padding: calc(20px + var(--sat)) calc(18px + var(--sar)) calc(20px + var(--sab)) calc(18px + var(--sal));
  box-shadow: var(--lg-inner), var(--lg-shadow);
  backdrop-filter: var(--lg-blur);
  -webkit-backdrop-filter: var(--lg-blur);
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
  color: var(--accent-text);
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
  /* 与 .toc-item 同理：`.td-list` 是 flex column 滚动容器，
     不锁 shrink 会在标题极多时被压扁（现在靠内容超出才滚动，属侥幸） */
  flex-shrink: 0;
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
  color: var(--accent-text);
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
  color: var(--accent-text);
  font-size: 1.05rem;
  font-weight: 650;
  transition: all var(--dur) var(--ease);
}

.like-btn:hover:not(:disabled) {
  background: var(--accent-fill);
  color: #fff;
  transform: translateY(-2px);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 30%, transparent);
}

.like-btn.liked {
  background: var(--accent-fill);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  /* 目录自己滚到底就停，别把正文一起带动 */
  overscroll-behavior: contain;
  /* 抵掉卡片内边距把列表撑满（让高亮条贴到卡片左缘），
     这样目录项不必再用负 margin —— 负 margin 会被这里的 overflow 横向裁掉，
     表现为「标题只显示后半截」 */
  margin: 0 -14px;
  padding: 0 14px;
}

.toc-item {
  display: block;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.84rem;
  color: var(--text-2);
  border-left: 2px solid transparent;
  transition: all var(--dur) var(--ease);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 必须禁止收缩：`.toc-list` 是 flex column + max-height 的滚动容器，
     而本项的 `overflow: hidden`（单行省略号需要）会让 `min-height: auto`
     按规范失效归零 —— 于是 flex-shrink 把每一项压到 13.6px，
     长文（27 个标题）文字被纵向裁掉，且压缩后总高恰好等于容器高，
     scrollHeight === clientHeight，`overflow-y: auto` 永远不触发、目录根本滚不动。
     实测：1280×600 视口下 27 项全被压成 13.6px（自然高 34px）。 */
  flex-shrink: 0;
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
  color: var(--accent-text);
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
