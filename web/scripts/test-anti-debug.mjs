/**
 * anti-debug.js 行为回归（无需浏览器，node:vm 造一个最小 DOM）
 *
 * 覆盖两类场景：
 *  1. 误报回归：Edge Android / Edge iOS 的正常手机视口（outer-inner 天然差很大）不得触发遮蔽层
 *  2. 真检测：桌面 DevTools 级窗口差、元素测量异常仍必须触发；localStorage 开发模式可关闭
 *
 * 用法：
 *   node scripts/test-anti-debug.mjs                     # 跑当前 public/anti-debug.js
 *   node scripts/test-anti-debug.mjs path/to/old.js      # 对旧版本跑同一套用例（对比证据）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../public/anti-debug.js');
const code = readFileSync(target, 'utf8');

const UA = {
  /** iPadOS 13+「请求桌面网站」：Macintosh 外壳，不含 iPad/Mobile */
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  /** Android 平板：常见 Chromium 平板 UA 不带 Mobile 字样，但含 Android */
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0',
  edgeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

/** 造一个最小 DOM，执行脚本并手动驱动检测周期 */
function run({
  ua,
  outerW,
  innerW,
  outerH,
  innerH,
  elementAnomaly = false,
  devMode = false,
  cycles = 3,
  // iPadOS 桌面外壳判定要用到；默认按非触屏桌面（Mac 的 maxTouchPoints 是 0）
  platform = 'Win32',
  maxTouchPoints = 0,
  // 模拟 debugger 断点耗时：每次 Date.now() 前进这么多毫秒（0 = 不模拟）
  clockStepMs = 0,
}) {
  const appended = [];
  const listeners = new Map();
  const intervals = [];

  const makeElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      style: {},
      parentNode: null,
      children: [],
      innerHTML: '',
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        appended.push(child);
        return child;
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute() {},
      addEventListener() {},
    };
    // 还原真实行为：offsetWidth/Height 跟随 style 的数值（异常模式模拟 DevTools 停靠时的测量失真）
    for (const [prop, styleKey] of [
      ['offsetWidth', 'width'],
      ['offsetHeight', 'height'],
    ]) {
      Object.defineProperty(el, prop, {
        get() {
          const n = parseInt(el.style[styleKey], 10);
          const base = Number.isFinite(n) ? n : prop === 'offsetWidth' ? 120 : 90;
          // 异常：始终读回 120/90，于是 120→121 的增量检测失效
          return elementAnomaly ? (prop === 'offsetWidth' ? 120 : 90) : base;
        },
      });
    }
    return el;
  };

  const body = makeElement('body');
  const document = {
    hidden: false,
    body,
    createElement: (tag) => makeElement(tag),
    addEventListener: (type, fn) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    getElementById: (id) => appended.find((n) => n.id === id) ?? null,
  };

  const sandbox = {
    document,
    navigator: { userAgent: ua, platform, maxTouchPoints },
    localStorage: {
      getItem: (k) => (devMode && k === 'xalor_dev_mode' ? '1' : null),
      setItem: () => {},
    },
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    setTimeout: () => 0,
    // 只有明确要求模拟 debugger 耗时时才替换 Date.now()：检测脚本里 t0 = Date.now() 后紧跟 debugger，
    // 因此"每次调用前进 N 毫秒"正好等价于"debugger 停顿了 N 毫秒"，且不依赖真实时钟。
    Date: clockStepMs > 0
      ? (() => {
          let current = 1_700_000_000_000;
          const fake = { now: () => (current += clockStepMs) };
          return fake;
        })()
      : Date,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    outerWidth: outerW,
    innerWidth: innerW,
    outerHeight: outerH,
    innerHeight: innerH,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: target });
  for (const fn of listeners.get('DOMContentLoaded') ?? []) fn();
  const tick = intervals[0];
  for (let i = 0; i < cycles; i++) tick?.();
  return { shield: appended.some((n) => n.id === '__x_shield__') };
}

const cases = [
  {
    name: 'Edge Android 正常手机（outer-inner 高度差 215）不得触发',
    args: { ua: UA.edgeAndroid, outerW: 412, innerW: 412, outerH: 915, innerH: 700 },
    expect: false,
  },
  {
    name: 'Edge iOS 正常手机（outer-inner 高度差 300）不得触发',
    args: { ua: UA.edgeIOS, outerW: 390, innerW: 390, outerH: 844, innerH: 540 },
    expect: false,
  },
  {
    name: '桌面 Chrome + DevTools 级窗口差 400 必须触发',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1100, outerH: 900, innerH: 880 },
    expect: true,
  },
  {
    name: '桌面 Chrome 正常窗口（差 100）不得触发',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1440, outerH: 900, innerH: 800 },
    expect: false,
  },
  {
    name: '移动端 + 元素测量异常（真 DevTools/异常环境）仍必须触发',
    args: { ua: UA.edgeAndroid, outerW: 412, innerW: 412, outerH: 915, innerH: 700, elementAnomaly: true },
    expect: true,
  },
  {
    name: 'iPad「请求桌面网站」（Macintosh 外壳 + MacIntel + 多点触控）高差 400 不得触发',
    args: {
      ua: UA.ipadDesktop,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      outerW: 1180,
      innerW: 1180,
      outerH: 820,
      innerH: 420,
    },
    expect: false,
  },
  {
    name: 'iPad「请求桌面网站」+ 元素测量异常（真 DevTools）仍必须触发',
    args: {
      ua: UA.ipadDesktop,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      outerW: 1180,
      innerW: 1180,
      outerH: 820,
      innerH: 420,
      elementAnomaly: true,
    },
    expect: true,
  },
  {
    name: '真 Mac（platform=MacIntel 但 maxTouchPoints=0）高差 400 仍必须触发',
    args: { ua: UA.desktopChrome, platform: 'MacIntel', maxTouchPoints: 0, outerW: 1440, innerW: 1100, outerH: 900, innerH: 880 },
    expect: true,
  },
  {
    name: 'Android 平板（UA 不含 Mobile）不得触发',
    args: { ua: UA.androidTablet, platform: 'Linux armv8l', maxTouchPoints: 5, outerW: 800, innerW: 800, outerH: 1280, innerH: 1000 },
    expect: false,
  },
  {
    name: '桌面边界：高差 321 必须触发（阈值是">320"）',
    args: { ua: UA.desktopChrome, platform: 'MacIntel', outerW: 1440, innerW: 1440, outerH: 900, innerH: 579 },
    expect: true,
  },
  {
    name: '桌面边界：高差 320 不得触发（等于阈值不算超过）',
    args: { ua: UA.desktopChrome, platform: 'MacIntel', outerW: 1440, innerW: 1440, outerH: 900, innerH: 580 },
    expect: false,
  },
  {
    name: '桌面边界：debugger 149ms 不得触发（阈值 >150）',
    args: { ua: UA.desktopChrome, platform: 'MacIntel', outerW: 1440, innerW: 1440, outerH: 900, innerH: 880, clockStepMs: 149 },
    expect: false,
  },
  {
    name: '桌面边界：debugger 151ms 必须触发（阈值 >150）',
    args: { ua: UA.desktopChrome, platform: 'MacIntel', outerW: 1440, innerW: 1440, outerH: 900, innerH: 880, clockStepMs: 151 },
    expect: true,
  },
  {
    name: 'localStorage 开发模式可整体关闭检测',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1100, outerH: 900, innerH: 880, devMode: true },
    expect: false,
  },
];

let pass = 0;
let fail = 0;
console.log(`\n目标脚本：${target}`);
for (const c of cases) {
  let got;
  try {
    got = run(c.args).shield;
  } catch (e) {
    console.log(`  ✗ ${c.name} — 执行异常：${e.message}`);
    fail++;
    continue;
  }
  if (got === c.expect) {
    pass++;
    console.log(`  ✓ ${c.name}`);
  } else {
    fail++;
    console.log(`  ✗ ${c.name} — 期望屏蔽=${c.expect}，实际=${got}`);
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
