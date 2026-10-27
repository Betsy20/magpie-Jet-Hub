// 这个面板跑在 magpie 窗口的沙箱 iframe 里（P4，docs/subsystems/plugin-runtime.md）。
// 它不能直接联网，也不能碰 magpie 的 /api：一切走窗口。
//
// bridge.js 已经铺好了这几个东西，不用自己写 postMessage：
//   await magpie.ready        窗口答上话后拿到主题（{dark, lang, tokens}）
//   magpie.onTheme(fn)        主题或语言变了就调一次
//   await magpie.read(name)   读 package.json 里 magpie.permissions 声明过的数据
//   magpie.options.get/set()  本插件自己的选项
// 主题颜色由 bridge 摊成 --magpie-<token>，样式表直接用即可。

const PROVIDER = 'jet-hub';

// 插件声明的那份静态目录（对应 src/plugin.mjs 的 FALLBACK_MODELS）。
// 页面既不能联网也不能读包里的其它文件，所以这份写死在页面里。
// 登录之后 magpie 会用账号真实目录覆盖它 —— 真实的以 Providers 页里这个
// 供应商的模型列表为准，`curl 127.0.0.1:3425/v1/models` 也看得到。
const DECLARED = [
  'workbuddy/deepseek-v4.1-flash',
  'qoder/qfmodel',
  'qodercn/dfmodel',
  'zcode/GLM-5.3',
  'codearts/deepseek-v4.1-flash',
  'buddy/deepseek-v4.1-flash',
  'trae/deepseek-v4.1-flash',
  'autoclaw/zai_glm-5.3-flash',
  'loomy/DeepSeek-V4.1-Flash',
  'lobsterai/deepseek-flash',
  'officeace/deepseek-v4.1-flash',
  'astudio/xopdsv4flash0731in',
  'modelscope/deepseek-ai/DeepSeek-V4.1-Flash',
  'raccoon/sn-deepseek-v4-1-flash-1017',
  'opencode/beam-free',
  'jet-hub-auto/auto',
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setState(text, tone) {
  const s = document.getElementById('state');
  s.textContent = text;
  s.dataset.tone = tone;
}

// 只剥外层 provider 前缀：jet-hub/workbuddy/deepseek-v4.1-flash → workbuddy/deepseek-v4.1-flash
function bare(id) {
  const s = String(id || '');
  const p = PROVIDER + '/';
  return s.startsWith(p) ? s.slice(p.length) : s;
}

function drawModels(ids) {
  const ul = document.getElementById('models');
  ul.replaceChildren();
  if (!ids.length) {
    ul.append(el('li', 'wait', '登录后会列出各账号能用的模型'));
    return;
  }
  for (const full of ids) {
    const li = el('li');
    li.append(document.createTextNode(bare(full)));
    ul.append(li);
  }
}

function drawStats(s) {
  const box = document.getElementById('stats');
  box.replaceChildren();
  if (!s || !s.calls) {
    box.append(el('span', 'wait', '今天还没有走过我这边模型的请求'));
    return;
  }
  const rows = [
    ['请求', String(s.calls)],
    ['输入 token', String(s.input ?? 0)],
    ['输出 token', String(s.output ?? 0)],
    ['缓存命中', String(s.cacheRead ?? 0)],
    ['失败', String(s.errors ?? 0)],
  ];
  for (const [k, v] of rows) {
    const item = el('span', 'stat');
    item.append(el('span', 'k', k), el('span', 'v', v));
    box.append(item);
  }
}

async function main() {
  // 先说 hello；窗口 10 秒听不到会把这里换成「重试」卡片
  let theme;
  try {
    theme = await magpie.ready;
  } catch (err) {
    setState('没连上窗口', 'bad');
    throw err;
  }
  setState('已连上 magpie', 'ok');
  const paint = (t) => {
    const lang = document.getElementById('lang');
    if (lang) lang.textContent = t?.lang ? '界面语言 ' + t.lang : '';
  };
  paint(theme);
  magpie.onTheme(paint);

  // 供应商在不在、叫什么，从窗口拿（这是声明过的只读数据）
  try {
    const list = await magpie.read('providers:list');
    const mine = (Array.isArray(list) ? list : []).find((p) => String(p?.id) === PROVIDER);
    if (!mine) {
      setState('网关里还没有这个供应商', 'bad');
    } else if (mine.name && mine.name !== 'Jet Hub') {
      // 有人改过展示名就跟着改
      document.querySelector('.head h1').textContent = mine.name;
    }
  } catch {
    // 读不到就只影响这一行提示，不影响下面的内容
  }
  drawModels(DECLARED.map((m) => PROVIDER + '/' + m));

  // 用量：官方只给总计与前 20 个模型，取今天的
  try {
    drawStats(await magpie.read('usage:summary', { period: 'today' }));
  } catch {
    drawStats(null);
  }

  // 声明过什么就读得到什么，写出来给人看，别让人以为面板能偷别的
  const ul = document.getElementById('reads');
  const says = {
    'providers:list': '供应商的 id 和名字',
    'usage:summary': '用量总计与前 20 个模型',
  };
  for (const name of ['providers:list', 'usage:summary']) {
    const li = el('li');
    li.append(el('code', '', name), el('span', '', ' — ' + (says[name] || '')));
    ul.append(li);
  }

  const copy = document.getElementById('copy');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('gateway').textContent);
      copy.textContent = '已复制';
      copy.dataset.done = '1';
    } catch {
      copy.textContent = '复制失败';
    }
    setTimeout(() => { copy.textContent = '复制'; delete copy.dataset.done; }, 1600);
  };

  document.getElementById('ver').textContent = 'magpie-jet-hub';
}

main().catch((err) => {
  // 没 catch 的错误 bridge 已经替我们报给窗口了；这里补一次，确保有提示
  try {
    parent.postMessage({ magpie: 1, method: 'error', params: { message: String(err?.message || err) } }, '*');
  } catch {}
});
