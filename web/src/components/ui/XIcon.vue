<template>
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
  Activity, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Ban, BarChart3,
  Calendar, Check, ChevronLeft, ChevronRight, Clock, Clock3, Copy, Crown, Download, Eye,
  ExternalLink, FileClock, FileSearch, FileText, Flame, FolderOpen, Github, Globe, Heart, History,
  House, Keyboard, KeyRound, LayoutDashboard, Link, Link2, ListTree, Lock, LogOut,
  Mail, MailOpen, Megaphone, MessageCircleHeart, MessageSquare, MessagesSquare,
  MonitorOff, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, Pin, QrCode, ScrollText,
  Search, Settings, Settings2, Share2, ShieldAlert, ShieldCheck, Smile, SquarePen,
  Star, Sun, Tags, Twitter, Upload, User, Users, X, ImageOff, ZoomIn, ZoomOut,
  Bookmark, Trash2, RefreshCw, Bold, Italic, Code, Heading2, Quote, List, Image, Minus,
  Rss, Sparkles, MessageSquareOff, EyeOff, ListOrdered, ListChecks, Shuffle, Printer, Send,
  CornerUpRight,
} from 'lucide-vue-next';

// 显式图标映射：避免全量引入导致 chunk 过大，且可 tree-shake
const ICONS = {
  Activity, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Ban, BarChart3,
  Calendar, Check, ChevronLeft, ChevronRight, Clock, Clock3, Copy, Crown, Download, Eye,
  ExternalLink, FileClock, FileSearch, FileText, Flame, FolderOpen, Github, Globe, Heart, History,
  House, Keyboard, KeyRound, LayoutDashboard, Link, Link2, ListTree, Lock, LogOut,
  Mail, MailOpen, Megaphone, MessageCircleHeart, MessageSquare, MessagesSquare,
  MonitorOff, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, Pin, QrCode, ScrollText,
  Search, Settings, Settings2, Share2, ShieldAlert, ShieldCheck, Smile, SquarePen,
  Star, Sun, Tags, Twitter, Upload, User, Users, X, ImageOff, ZoomIn, ZoomOut,
  Bookmark, Trash2, RefreshCw, Bold, Italic, Code, Heading2, Quote, List, Image, Minus,
  Rss, Sparkles, MessageSquareOff, EyeOff, ListOrdered, ListChecks, Shuffle, Printer, Send,
  CornerUpRight,
};

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  strokeWidth: { type: [Number, String], default: 1.8 },
  fill: { type: [Boolean, String], default: undefined },
});

const iconComponent = computed(() => {
  return ICONS[props.name] || Activity;
});

// fill 规范化：true → currentColor（跟随文本色），false/undefined → none
const resolvedFill = computed(() => {
  if (props.fill === true || props.fill === 'true') return 'currentColor';
  if (typeof props.fill === 'string' && props.fill) return props.fill;
  return 'none';
});
</script>
