/**
 * anti-debug.js 行为回归（无需浏览器，node:vm 造一个最小 DOM）
 *
 * 覆盖四类场景：
 *  1. 误报回归：Edge Android / Edge iOS / Android 平板 / iPad 桌面壳的正常视口不得触发遮蔽层
 *  2. 真检测：桌面 DevTools 级窗口差、元素测量异常、debugger 耗时必须触发
 *  3. 自动恢复：关掉 DevTools 后遮蔽层必须摘掉、无限 debugger 定时器必须停掉
 *  4. console 策略：只静默闲聊渠道，console.error 必须透出（否则全局兜底失效 → 静默白屏）
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
  // 第 N 个周期起不再满足任何检测条件（模拟「用户关掉了 DevTools」），用于验证自动恢复
  clearFromCycle = Infinity,
  // 期望被调用的 console 方法（用于验证 error 没有被静默）
  callConsole = null,
  // iPadOS 桌面外壳判定要用到；默认按非触屏桌面（Mac 的 maxTouchPoints 是 0）
  platform = 'Win32',
  maxTouchPoints = 0,
  // 模拟 debugger 断点耗时：每次 Date.now() 前进这么多毫秒（0 = 不模拟）
  clockStepMs = 0,
}) {
  const appended = [];
  const listeners = new Map();
  const intervals = [];
  /** 仍存活（未 clearTimeout）的 setTimeout 句柄数：模拟无限 debugger 循环是否停下 */
  const liveTimeouts = new Map();
  const consoleCalls = [];
  let timerSeq = 0;

  // 可变状态用 ref 包一层：对象里 def 出去的 getter 需要读到「后来被测试改掉」的值
  const elementAnomalyRef = { value: elementAnomaly };
  const clockStepMsRef = { value: clockStepMs };

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
        // 真实 DOM 的 removeChild 之后元素就不在文档里了；getElementById 依赖 appended，
        // 所以这里必须同步移除，否则遮蔽层「摘掉了」仍会被查出来，测不出真实状态。
        const j = appended.indexOf(child);
        if (j >= 0) appended.splice(j, 1);
        return child;
      },
      setAttribute() {},
      addEventListener() {},
    };
    // 检测脚本本身会读取 el.id === '__x_shield__'，所以 id 必须是可写普通属性。
    // 还原真实行为：offsetWidth/Height 跟随 style 的数值（异常模式模拟 DevTools 停靠时的测量失真）
    for (const [prop, styleKey] of [
      ['offsetWidth', 'width'],
      ['offsetHeight', 'height'],
    ]) {
      Object.defineProperty(el, prop, {
        get() {
          // 关闭检测时不再模拟测量失真
          if (elementAnomalyRef.value) return prop === 'offsetWidth' ? 120 : 90;
          const n = parseInt(el.style[styleKey], 10);
          return Number.isFinite(n) ? n : prop === 'offsetWidth' ? 120 : 90;
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

  // 只有明确要求模拟 debugger 耗时时才替换 Date.now()：检测脚本里 t0 = Date.now() 后紧跟 debugger，
  // 因此「每次调用前进 N 毫秒」正好等价于「debugger 停顿了 N 毫秒」，且不依赖真实时钟。
  const Clock = (() => {
    let current = 1_700_000_000_000;
    return {
      now: () => (current += clockStepMsRef.value),
    };
  })();

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
    // 记录仍存活的定时器，便于断言「无限 debugger 循环是否真的停了」；
    // 不真的排队回调（否则无限循环会跑飞），只保留句柄语义。
    setTimeout: (fn) => {
      timerSeq += 1;
      liveTimeouts.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimeout: (id) => {
      liveTimeouts.delete(id);
    },
    Date: Clock,
    console: {
      log: (...a) => consoleCalls.push(['log', ...a]),
      info: (...a) => consoleCalls.push(['info', ...a]),
      warn: (...a) => consoleCalls.push(['warn', ...a]),
      error: (...a) => consoleCalls.push(['error', ...a]),
      debug: (...a) => consoleCalls.push(['debug', ...a]),
      trace: (...a) => consoleCalls.push(['trace', ...a]),
    },
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

  // 检测脚本在此之后才覆写 window.eval / console 等方法，所以上面的桩都已经就位。
  if (callConsole) sandbox.console[callConsole]('probe');

  const tick = intervals[0];
  /** 每个周期的遮蔽层存在性，便于观察「触发 → 恢复」的完整过程 */
  const shieldTimeline = [];
  for (let i = 0; i < cycles; i++) {
    // 模拟用户关掉 DevTools：之后的周期不再有任何命中
    if (i >= clearFromCycle) {
      sandbox.outerWidth = sandbox.innerWidth;
      sandbox.outerHeight = sandbox.innerHeight;
      elementAnomalyRef.value = false;
      clockStepMsRef.value = 0;
    }
    tick?.();
    shieldTimeline.push(appended.some((n) => n.id === '__x_shield__'));
  }
  return {
    shield: shieldTimeline[shieldTimeline.length - 1] ?? false,
    /** 是否「曾经」出现过遮蔽层 */
    everShielded: shieldTimeline.some(Boolean),
    shieldTimeline,
    liveTimeouts: liveTimeouts.size,
    consoleCalls,
  };
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
    name: '桌面边界：高差 321 必须触发（阈值是 ">320"）',
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
  {
    name: '单周期命中不触发（连续 2 个周期才算 DevTools）',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1100, outerH: 900, innerH: 880, cycles: 1 },
    expect: false,
  },
];

/** 行为断言（不是「最终有没有遮蔽层」，而是完整过程） */
const behaviorCases = [
  {
    name: '关掉 DevTools 后遮蔽层必须自动摘除（旧版这里永远摘不掉）',
    args: {
      ua: UA.desktopChrome,
      outerW: 1440,
      innerW: 1100,
      outerH: 900,
      innerH: 880,
      cycles: 5,
      clearFromCycle: 2,
    },
    check: (r) => r.everShielded === true && r.shield === false,
    detail: (r) => `曾遮蔽=${r.everShielded}，最终遮蔽=${r.shield}，时间线=${JSON.stringify(r.shieldTimeline)}`,
  },
  {
    name: '关掉 DevTools 后无限 debugger 定时器必须清空（否则 0ms 定时器永久拖慢页面）',
    args: {
      ua: UA.desktopChrome,
      outerW: 1440,
      innerW: 1100,
      outerH: 900,
      innerH: 880,
      cycles: 5,
      clearFromCycle: 2,
    },
    check: (r) => r.liveTimeouts === 0,
    detail: (r) => `存活定时器=${r.liveTimeouts}`,
  },
  {
    name: '触发期间 debugger 循环只有一个存活定时器（不得每周期叠一个）',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1100, outerH: 900, innerH: 880, cycles: 6 },
    check: (r) => r.liveTimeouts === 1,
    detail: (r) => `存活定时器=${r.liveTimeouts}`,
  },
  {
    name: 'console.error 必须透出（全局兜底 / 白屏排查依赖它）',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1440, outerH: 900, innerH: 800, callConsole: 'error' },
    check: (r) => r.consoleCalls.some((c) => c[0] === 'error' && c[1] === 'probe'),
    detail: (r) => `console 调用=${JSON.stringify(r.consoleCalls)}`,
  },
  {
    name: 'console.log 必须被静默（闲聊渠道不留调试入口）',
    args: { ua: UA.desktopChrome, outerW: 1440, innerW: 1440, outerH: 900, innerH: 800, callConsole: 'log' },
    check: (r) => !r.consoleCalls.some((c) => c[0] === 'log' && c[1] === 'probe'),
    detail: (r) => `console 调用=${JSON.stringify(r.consoleCalls)}`,
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

for (const c of behaviorCases) {
  let r;
  try {
    r = run(c.args);
  } catch (e) {
    console.log(`  ✗ ${c.name} — 执行异常：${e.message}`);
    fail++;
    continue;
  }
  if (c.check(r)) {
    pass++;
    console.log(`  ✓ ${c.name}`);
  } else {
    fail++;
    console.log(`  ✗ ${c.name} — ${c.detail(r)}`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
