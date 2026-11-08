<template>
  <!-- 图标默认为装饰性：lucide-vue-next 在「没有插槽内容且没有传任何 aria-* / role / title」时
       会自动加 aria-hidden="true"（见 node_modules/lucide-vue-next/dist/esm/Icon.js:41）。
       所以这里不需要手动加 —— 反过来，需要语义的图标只要传 aria-label 就会自动取消隐藏。
       已确认：全仓 256 处 XIcon 都没有传 a11y 属性（全是装饰性），符合预期。
       focusable="false" 在 lucide 的 defaultAttributes 里没有，但它只影响 IE11 / 旧 Edge
       （svg 默认可聚焦），现代浏览器忽略这个属性，不值得为此包一层。 -->
  <component
    :is="iconComponent"
    :size="size"
    :stroke-width="strokeWidth"
    :fill="resolvedFill"
    :absolute-stroke-width="true"
  />
</template>

<script setup>
import { computed } from 'vue';
import {
  Activity, Feather, MapPin, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Ban, BarChart3,
  Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Clock3, Copy, Crown, Download, Eye,
  ExternalLink, FileClock, FileSearch, FileText, Flame, FolderOpen, Github, Globe, Heart, History,
  House, Keyboard, KeyRound, LayoutDashboard, Link, Link2, ListTree, Lock, LogOut,
  Mail, MailOpen, Megaphone, MessageCircleHeart, MessageSquare, MessagesSquare,
  MonitorOff, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, Pin, QrCode, ScrollText,
  Search, Settings, Settings2, Share2, ShieldAlert, ShieldCheck, Smile, SquarePen,
  Star, Sun, Tags, Twitter, Upload, User, Users, X, ImageOff, ZoomIn, ZoomOut,
  Bookmark, Trash2, RefreshCw, Bold, Italic, Code, Heading2, Quote, List, Image, Minus,
  Rss, Sparkles, MessageSquareOff, EyeOff, ListOrdered, ListChecks, Shuffle, Printer, Send,
  CornerUpRight, SlidersHorizontal,
} from 'lucide-vue-next';

// 显式图标映射：避免全量引入导致 chunk 过大，且可 tree-shake
const ICONS = {
  Activity, Feather, MapPin, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Ban, BarChart3,
  Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Clock3, Copy, Crown, Download, Eye,
  ExternalLink, FileClock, FileSearch, FileText, Flame, FolderOpen, Github, Globe, Heart, History,
  House, Keyboard, KeyRound, LayoutDashboard, Link, Link2, ListTree, Lock, LogOut,
  Mail, MailOpen, Megaphone, MessageCircleHeart, MessageSquare, MessagesSquare,
  MonitorOff, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, Pin, QrCode, ScrollText,
  Search, Settings, Settings2, Share2, ShieldAlert, ShieldCheck, Smile, SquarePen,
  Star, Sun, Tags, Twitter, Upload, User, Users, X, ImageOff, ZoomIn, ZoomOut,
  Bookmark, Trash2, RefreshCw, Bold, Italic, Code, Heading2, Quote, List, Image, Minus,
  Rss, Sparkles, MessageSquareOff, EyeOff, ListOrdered, ListChecks, Shuffle, Printer, Send,
  CornerUpRight, SlidersHorizontal,
};

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  strokeWidth: { type: [Number, String], default: 1.8 },
  fill: { type: [Boolean, String], default: undefined },
});

/**
 * 未注册的图标名**回退到 Activity**，但要让它可见。
 *
 * 静默回退的问题：图标名打错（`MessageSquar`、`Envelope`——后者根本没注册）时，
 * 界面上出现的是一个毫无意义的「心电波」图标，而控制台干干净净。
 * 这类错误只能靠肉眼发现，而且经常被当成"设计就是这样"。
 *
 * 只在开发期告警：生产构建由 terser 的 drop_console 剥掉，不会污染用户控制台。
 * `warnedMissing` 做去重 —— computed 在依赖变化时会重算，同一个错名不该刷屏。
 */
const warnedMissing = new Set();
const iconComponent = computed(() => {
  const hit = ICONS[props.name];
  if (hit) return hit;
  if (import.meta.env.DEV && !warnedMissing.has(props.name)) {
    warnedMissing.add(props.name);
    console.warn(`[XIcon] 未注册的图标名「${props.name}」，已回退为 Activity。可用名称见 ICONS 映射。`);
  }
  return Activity;
});

// fill 规范化：true → currentColor（跟随文本色），false/undefined → none
const resolvedFill = computed(() => {
  if (props.fill === true || props.fill === 'true') return 'currentColor';
  if (typeof props.fill === 'string' && props.fill) return props.fill;
  return 'none';
});
</script>
