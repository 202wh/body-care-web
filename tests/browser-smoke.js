/* 真实浏览器冒烟测试(不依赖第三方库,通过 Chrome DevTools Protocol 驱动)
   运行:node tests/browser-smoke.js
   覆盖:首屏渲染、新增/编辑记录、错误输入、日期处理、习惯打卡、
         体重趋势、演示数据隔离、持久化、导出、导入(含错误文件)、清空确认、
         移动端横向溢出、标签与外部请求检查。
   说明:这是本机无头 Chrome 的真实运行结果,不模拟、不伪造。 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const PORT = 9400 + Math.floor(Math.random() * 200);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'haohao-smoke-'));
const SHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haohao-shots-'));

let passed = 0;
const failures = [];
function ok(name) {
  passed += 1;
  console.log('  ok  ' + name);
}
function check(name, cond, detail) {
  if (cond) return ok(name);
  failures.push(name + (detail ? ' —— ' + detail : ''));
  console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function waitForJson(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.log('找不到 Chrome,跳过浏览器测试');
    process.exit(2);
  }

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--window-size=1280,900',
    PAGE_URL
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const targets = await waitForJson('http://127.0.0.1:' + PORT + '/json/list');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有找到页面目标');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    const evalPage = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture: true
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text;
        throw new Error('页面脚本异常: ' + d);
      }
      return res.result.value;
    };

    const waitFor = async (expression, timeout = 5000, label = '条件') => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evalPage('(function(){try{return !!(' + expression + ')}catch(e){return false}})()')) return true;
        await sleep(120);
      }
      throw new Error('等待超时:' + label);
    };

    const pageErrors = () => cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text
        : e.params.entry.text);

    console.log('\n[0] 首屏加载');
    await waitFor("document.querySelector('#todaySummary').textContent.length > 5", 8000, '首屏渲染');
    check('脚本执行且首屏渲染完成', true);
    check('初次进入不是演示模式', await evalPage("!document.body.classList.contains('is-demo')"));
    check('演示提示条默认不占据空间', await evalPage("getComputedStyle(document.getElementById('demoBanner')).display === 'none'"));
    check('“今天的一件小事”已填入内容', (await evalPage("document.getElementById('smallThingText').textContent.length")) > 6);
    check('页面没有脚本异常', pageErrors().length === 0, pageErrors().join(' | '));
    const storageOk = await evalPage("(() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch(e) { return false; } })()");
    check('file:// 下 localStorage 可用', storageOk === true);

    console.log('\n[1] 桌面布局');
    const desk = await evalPage("({iw: innerWidth, sw: document.documentElement.scrollWidth, bsw: document.body.scrollWidth})");
    check('桌面无横向溢出', desk.sw <= desk.iw + 1, JSON.stringify(desk));

    console.log('\n[2] 移动布局(390px)');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(300);
    const mob = await evalPage(`(() => {
      const iw = innerWidth;
      const wide = [];
      document.querySelectorAll('body *').forEach((node) => {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.right > iw + 1) {
          wide.push({ tag: node.tagName.toLowerCase(), cls: node.className && String(node.className).slice(0, 40), id: node.id, right: Math.round(r.right), w: Math.round(r.width) });
        }
      });
      return { iw, sw: document.documentElement.scrollWidth, wide: wide.slice(0, 8) };
    })()`);
    check('移动端(390px)无横向溢出', mob.sw <= mob.iw + 1, 'scrollWidth=' + mob.sw + ' innerWidth=' + mob.iw + ' 溢出元素:' + JSON.stringify(mob.wide));

    const smallTap = await evalPage(`(() => {
      const btn = document.getElementById('btnSave');
      const r = btn.getBoundingClientRect();
      return { h: Math.round(r.height), visible: r.width > 0 };
    })()`);
    check('移动端主按钮高度不小于 36px', smallTap.h >= 36 && smallTap.visible, 'height=' + smallTap.h);

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'mobile-check.png'), Buffer.from(r.data, 'base64'));
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 720, deviceScaleFactor: 2, mobile: true
    });
    await sleep(250);
    const narrow = await evalPage("({iw: innerWidth, sw: document.documentElement.scrollWidth})");
    check('窄屏(320px)无横向溢出', narrow.sw <= narrow.iw + 1, JSON.stringify(narrow));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(250);

    console.log('\n[3] 新增与编辑记录');
    const today = await evalPage('window.CareCore.todayKey()');
    const addEntry = async (dateKey, fields) => {
      return evalPage(`(async () => {
        const d = document.getElementById('entryDate');
        d.value = ${JSON.stringify(dateKey)};
        d.dispatchEvent(new Event('change', { bubbles: true }));
        ${Object.keys(fields).map((k) => 'document.getElementById(' + JSON.stringify(k) + ').value = ' + JSON.stringify(String(fields[k])) + ';').join('\n')}
        document.getElementById('entryForm').requestSubmit();
        await new Promise(r => setTimeout(r, 120));
        return document.getElementById('entryStatus').textContent;
      })()`);
    };

    await addEntry('2026-11-20', { fWeight: 62.6, fSleep: 7, fActivity: 25 });

    // 心情是单选组,单独勾选后再保存一次,让这条记录带上心情
    await evalPage(`(async () => {
      const d = document.getElementById('entryDate'); d.value = '2026-11-20';
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('input[name="mood"][value="平静"]').checked = true;
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);

    const saved1 = await evalPage("localStorage.getItem('haohao-care:v1:real')");
    check('保存后写入真实数据键', !!saved1);
    const store1 = saved1 ? JSON.parse(saved1) : { entries: {} };
    check('2026-11-20 记录已保存且包含体重/睡眠/运动/心情',
      !!(store1.entries['2026-11-20'] && store1.entries['2026-11-20'].weight === 62.6 && store1.entries['2026-11-20'].mood === '平静'),
      JSON.stringify(store1.entries['2026-11-20']));

    await addEntry('2026-11-24', { fWeight: 62.2, fWaist: 80, fActivity: 40 });
    await addEntry(today, { fWeight: 61.9, fSleep: 7.5, fActivity: 30 });
    await evalPage(`(async () => {
      document.querySelector('input[name="mood"][value="轻松"]').checked = true;
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);

    const afterAdd = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('三天记录都已写入', Object.keys(afterAdd.entries).length === 3, 'entries=' + Object.keys(afterAdd.entries).join(','));
    check('保存后状态文案更新', (await evalPage("document.getElementById('entryStatus').textContent")).includes('已保存'));

    // 编辑同一天
    await evalPage(`(async () => {
      const d = document.getElementById('entryDate'); d.value = ${JSON.stringify(today)};
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('fWeight').value = '62.0';
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);
    const afterEdit = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('编辑同一天覆盖为 62.0', afterEdit.entries[today].weight === 62.0, JSON.stringify(afterEdit.entries[today]));
    check('编辑后其他字段保留', afterEdit.entries[today].sleep === 7.5 && afterEdit.entries[today].mood === '轻松');

    console.log('\n[4] 错误输入与日期校验');
    await evalPage(`(() => { document.getElementById('fWeight').value = '999'; document.getElementById('entryForm').requestSubmit(); })()`);
    await sleep(150);
    const errState = await evalPage(`({
      active: document.getElementById('formErrors').dataset.active,
      text: document.getElementById('formErrors').textContent,
      invalid: document.getElementById('fWeight').getAttribute('aria-invalid'),
      focused: document.activeElement && document.activeElement.id
    })`);
    check('超范围体重被拦截并提示', errState.active === 'true' && errState.text.includes('体重'), JSON.stringify(errState));
    check('错误字段标记 aria-invalid 并聚焦', errState.invalid === 'true' && errState.focused === 'fWeight', JSON.stringify(errState));
    const noOverwrite = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('非法输入没有覆盖已保存数据', noOverwrite.entries[today].weight === 62.0);

    await evalPage(`(() => { document.getElementById('fWeight').value = ''; document.getElementById('entryDate').value = ''; document.getElementById('entryForm').requestSubmit(); })()`);
    await sleep(150);
    check('清空日期后保存被拦截', (await evalPage("document.getElementById('formErrors').textContent")).includes('请选择日期'));

    await evalPage(`(async () => {
      const d = document.getElementById('entryDate'); d.value = '2026-12-01';
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('fSleep').value = '8';
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);
    check('未来日期被拦截', (await evalPage("document.getElementById('formErrors').textContent")).includes('不能记录今天以后'));
    const futureCheck = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('未来日期没有写入', !futureCheck.entries['2026-12-01']);

    await evalPage(`(async () => {
      const d = document.getElementById('entryDate'); d.value = ${JSON.stringify(today)};
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('fWeight').value = '';
      document.getElementById('fWaist').value = '';
      document.getElementById('fSleep').value = '';
      document.getElementById('fActivity').value = '';
      document.querySelector('input[name="mood"][value=""]').checked = true;
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);
    check('全部留空时提示至少填写一项', (await evalPage("document.getElementById('formErrors').textContent")).includes('至少填写一项'));

    console.log('\n[5] 习惯打卡');
    await evalPage(`(async () => {
      document.getElementById('habitName').value = '饭后散步';
      document.getElementById('habitTarget').value = '4';
      document.getElementById('habitForm').requestSubmit();
      await new Promise(r => setTimeout(r, 100));
    })()`);
    const habitStore = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('习惯添加成功并持久化', habitStore.habits.length === 1 && habitStore.habits[0].targetPerWeek === 4, JSON.stringify(habitStore.habits));
    check('习惯列表已渲染', (await evalPage("document.querySelectorAll('.habit-row').length")) === 1);

    const habitId = habitStore.habits[0].id;
    await evalPage(`(() => { const c = document.querySelector('.day-cell[data-date="${today}"]'); c.click(); })()`);
    await sleep(120);
    const checkedStore = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('当天打卡写入', (checkedStore.habitChecks[today] || []).includes(habitId), JSON.stringify(checkedStore.habitChecks));
    check('打卡按钮 aria-pressed 同步', await evalPage(`document.querySelector('.day-cell[data-date="${today}"]').getAttribute('aria-pressed') === 'true'`));
    check('未来日期格子不可点', await evalPage(`document.querySelector('.day-cell[data-date="2026-11-29"]').disabled === true`));

    await evalPage(`(() => { const i = document.querySelector('[data-habit-target="${habitId}"]'); i.value = '2'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(120);
    const targetStore = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('每周目标可修改为 2', targetStore.habits[0].targetPerWeek === 2);

    await evalPage(`(() => {
      document.getElementById('habitName').value = '饭后散步';
      document.getElementById('habitForm').requestSubmit();
    })()`);
    await sleep(100);
    check('重名习惯被拒绝', (await evalPage("document.getElementById('habitErrors').textContent")).includes('已经有一个'));

    await evalPage(`(() => {
      const btn = document.getElementById('habitSuggestions').querySelector('[data-suggest="一份蔬果"]');
      btn.click();
    })()`);
    await sleep(120);
    const twoHabits = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('建议习惯一键添加', twoHabits.habits.length === 2);

    const habitRows = await evalPage(`[...document.querySelectorAll('.habit-row')].map((row) => ({
      meta: row.querySelector('.meta').textContent,
      pressed: [...row.querySelectorAll('.day-cell')].filter((c) => c.getAttribute('aria-pressed') === 'true').length
    }))`);
    const habitConsistent = habitRows.every((row) => {
      const m = /本周完成 (\d+) 天/.exec(row.meta);
      return m && Number(m[1]) === row.pressed;
    });
    check('每行“本周完成”与绿色格子数量一致', habitConsistent, JSON.stringify(habitRows));

    console.log('\n[6] 趋势与复盘');
    const trend = await evalPage(`({
      hasSvg: !!document.querySelector('#trendChart svg'),
      label: (document.querySelector('#trendChart svg') || {}).getAttribute ? document.querySelector('#trendChart svg').getAttribute('aria-label') : '',
      summary: document.getElementById('trendSummary').textContent,
      stats: document.getElementById('trendStats').textContent,
      review: document.getElementById('reviewLines').textContent
    })`);
    check('趋势图渲染为 SVG', trend.hasSvg === true);
    check('图表带文字替代描述', (trend.label || '').includes('共记录'), trend.label);
    check('文字摘要包含平均与范围', trend.summary.includes('平均') && trend.summary.includes('最低'), trend.summary);
    check('统计卡显示记录次数', trend.stats.includes('记录次数'));
    check('每周复盘输出文字', trend.review.includes('本周记录了'), trend.review);

    await evalPage("document.getElementById('range30').click()");
    await sleep(100);
    check('切换到 30 天后 aria-pressed 正确', await evalPage("document.getElementById('range30').getAttribute('aria-pressed') === 'true'"));
    check('30 天摘要文案更新', (await evalPage("document.getElementById('trendSummary').textContent")).includes('最近 30 天'));
    await evalPage("document.getElementById('range7').click()");

    console.log('\n[7] 演示数据隔离');
    const realBefore = await evalPage("localStorage.getItem('haohao-care:v1:real')");
    await evalPage("document.getElementById('btnDemoOn').click()");
    await sleep(300);
    check('演示模式提示条可见', await evalPage("getComputedStyle(document.getElementById('demoBanner')).display !== 'none'"));
    check('body 标记为演示模式', await evalPage("document.body.classList.contains('is-demo')"));
    check('演示数据独立写入 demo 键', await evalPage("!!localStorage.getItem('haohao-care:v1:demo')"));
    check('真实数据未被读取为演示数据', (await evalPage("localStorage.getItem('haohao-care:v1:real')")) === realBefore);
    check('演示数据有示例记录', (await evalPage("Object.keys(JSON.parse(localStorage.getItem('haohao-care:v1:demo')).entries).length")) >= 20);

    await evalPage(`(async () => {
      const d = document.getElementById('entryDate');
      d.value = ${JSON.stringify(today)};
      d.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('fWeight').value = '99';
      document.getElementById('entryForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
    })()`);
    const demoStore = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:demo')"));
    check('演示模式内的修改只写 demo 键', demoStore.entries[today].weight === 99, JSON.stringify(demoStore.entries[today]));
    check('演示修改不影响真实数据', (await evalPage("localStorage.getItem('haohao-care:v1:real')")) === realBefore);

    const demoExport = await evalPage(`(async () => {
      const origCreate = URL.createObjectURL;
      const origClick = HTMLAnchorElement.prototype.click;
      let blob = null, name = null;
      URL.createObjectURL = function (b) { blob = b; return origCreate.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { name = this.download; };
      document.getElementById('btnExport').click();
      await new Promise(r => setTimeout(r, 60));
      const text = blob ? await blob.text() : '';
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
      return { name, text };
    })()`);
    let demoJson = null;
    try { demoJson = JSON.parse(demoExport.text); } catch (e) { /* ignore */ }
    check('演示模式导出的文件名带 demo 标记', /demo-/.test(demoExport.name || ''), demoExport.name);
    check('演示导出内容带 demo:true 标记', !!demoJson && demoJson.demo === true);

    await evalPage("document.getElementById('btnDemoOff').click()");
    await sleep(300);
    check('退出演示后提示条隐藏', await evalPage("getComputedStyle(document.getElementById('demoBanner')).display === 'none'"));
    const fw = await evalPage("document.getElementById('fWeight').value");
    check('退出演示后表单回到真实体重 62(不是演示的 99)', fw === '62', 'value=' + fw);
    check('演示数据保留在独立键中', (await evalPage("JSON.parse(localStorage.getItem('haohao-care:v1:demo')).entries['" + today + "'].weight")) === 99);

    console.log('\n[8] 持久化与刷新');
    await cdp.send('Page.reload');
    await waitFor("document.querySelector('#todaySummary') && document.querySelector('#todaySummary').textContent.length > 0", 8000, '刷新后渲染');
    await sleep(250);
    const afterReload = await evalPage(`({
      weight: document.getElementById('fWeight').value,
      count: Object.keys(JSON.parse(localStorage.getItem('haohao-care:v1:real') || '{}').entries || {}).length,
      habits: document.querySelectorAll('.habit-row').length,
      demo: document.body.classList.contains('is-demo'),
      chart: !!document.querySelector('#trendChart svg')
    })`);
    check('刷新后记录仍在并回填表单', afterReload.weight === '62', JSON.stringify(afterReload));
    check('刷新后仍是 3 天记录', afterReload.count === 3);
    check('刷新后习惯仍在', afterReload.habits === 2);
    check('刷新后不处于演示模式', afterReload.demo === false);
    check('刷新后趋势图仍渲染', afterReload.chart === true);

    console.log('\n[9] 导出');
    const exported = await evalPage(`(async () => {
      const origCreate = URL.createObjectURL;
      const origClick = HTMLAnchorElement.prototype.click;
      let blob = null, name = null;
      URL.createObjectURL = function (b) { blob = b; return origCreate.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { name = this.download; };
      document.getElementById('btnExport').click();
      await new Promise(r => setTimeout(r, 60));
      const text = blob ? await blob.text() : '';
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
      return { name, text };
    })()`);
    let exportJson = null;
    try { exportJson = JSON.parse(exported.text); } catch (e) { /* ignore */ }
    check('导出文件名包含日期与 .json', /haohao-care-.*\.json$/.test(exported.name || ''), exported.name);
    check('导出内容可解析为 JSON', !!exportJson);
    check('导出包含应用标识与版本', !!exportJson && exportJson.app === 'haohao-care' && exportJson.version === 1);
    check('导出包含三天记录', !!exportJson && Object.keys(exportJson.data.entries).length === 3);

    console.log('\n[10] 导入');
    const injectFile = async (content, name) => {
      await evalPage(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name || 'backup.json')}, { type: 'application/json' }));
        const input = document.getElementById('importFile');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(250);
    };
    const dialogState = () => evalPage(`({
      open: document.getElementById('confirmDialog').open,
      title: document.getElementById('dialogTitle').textContent,
      body: document.getElementById('dialogContent').textContent,
      buttons: [...document.querySelectorAll('#dialogActions button')].map(b => b.textContent.trim())
    })`);
    const clickDialog = async (label) => {
      const done = await evalPage(`(() => {
        const btn = [...document.querySelectorAll('#dialogActions button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      await sleep(200);
      return done;
    };

    await injectFile('{broken json', 'broken.json');
    let dlg = await dialogState();
    check('损坏 JSON 被识别并弹窗', dlg.open && dlg.title.includes('不是有效的 JSON'), JSON.stringify(dlg));
    await clickDialog('知道了');
    check('损坏文件弹窗可关闭且数据未变', (await evalPage("Object.keys(JSON.parse(localStorage.getItem('haohao-care:v1:real')).entries).length")) === 3);

    const badPayload = JSON.stringify({ app: 'haohao-care', version: 1, data: { entries: { '2026-11-01': { weight: 9000 } } } });
    await injectFile(badPayload, 'bad-range.json');
    dlg = await dialogState();
    check('超范围数据被拒绝并列出原因', dlg.open && dlg.title.includes('没有通过检查') && dlg.body.includes('体重应在'), JSON.stringify(dlg));
    await clickDialog('知道了');

    const payload = JSON.parse(exported.text);
    payload.data.entries['2026-11-18'] = { weight: 63.0, sleep: 6.5 };
    await injectFile(JSON.stringify(payload), 'merge.json');
    dlg = await dialogState();
    check('合法备份弹出导入确认', dlg.open && dlg.title.includes('导入这份备份') && dlg.buttons.includes('合并到现有记录'), JSON.stringify(dlg));
    await clickDialog('合并到现有记录');
    const merged = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('合并导入新增一天且保留原有记录', Object.keys(merged.entries).length === 4 && merged.entries['2026-11-18'].weight === 63, Object.keys(merged.entries).join(','));

    dlg = await dialogState();
    check('导入完成后弹窗关闭', dlg.open === false);

    // 删除单条记录(先取消再确认)
    await evalPage(`(async () => {
      const d = document.getElementById('entryDate'); d.value = '2026-11-18';
      d.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      document.getElementById('btnDeleteEntry').click();
    })()`);
    await sleep(200);
    dlg = await dialogState();
    check('删除单条记录前弹出确认', dlg.open && dlg.title.includes('删除这天的记录'), JSON.stringify(dlg));
    await clickDialog('先留着');
    check('取消删除后记录仍在', (await evalPage("Object.keys(JSON.parse(localStorage.getItem('haohao-care:v1:real')).entries).length")) === 4);

    await evalPage("document.getElementById('btnDeleteEntry').click()");
    await sleep(200);
    await clickDialog('删除这条记录');
    const afterDelete = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('确认后只删除当天记录', Object.keys(afterDelete.entries).length === 3 && !afterDelete.entries['2026-11-18']);
    check('删除当天记录不影响习惯', afterDelete.habits.length === 2);

    // 替换导入
    const replacePayload = { app: 'haohao-care', version: 1, data: { entries: { '2026-11-10': { weight: 60.5 } }, habits: [], habitChecks: {}, meta: {} } };
    await injectFile(JSON.stringify(replacePayload), 'replace.json');
    dlg = await dialogState();
    check('替换前同样需要确认', dlg.open && dlg.buttons.includes('替换全部记录'));
    await clickDialog('替换全部记录');
    const replaced = JSON.parse(await evalPage("localStorage.getItem('haohao-care:v1:real')"));
    check('替换后只剩导入的一天', Object.keys(replaced.entries).length === 1 && replaced.entries['2026-11-10'].weight === 60.5);
    check('替换后习惯被清空(符合“替换全部”说明)', replaced.habits.length === 0);

    console.log('\n[11] 清空确认');
    await evalPage("document.getElementById('btnClear').click()");
    await sleep(200);
    dlg = await dialogState();
    check('清空前弹出确认框', dlg.open && dlg.title.includes('确定清空'));
    await clickDialog('先不清理');
    check('取消后数据保留', (await evalPage("Object.keys(JSON.parse(localStorage.getItem('haohao-care:v1:real')).entries).length")) === 1);

    await evalPage("document.getElementById('btnClear').click()");
    await sleep(200);
    await clickDialog('确认清空');
    check('确认后本地数据被删除', await evalPage("localStorage.getItem('haohao-care:v1:real')") === null);
    check('清空后表单回到空状态', (await evalPage("document.getElementById('fWeight').value")) === '');
    check('清空后今日概览为空状态文案', (await evalPage("document.getElementById('todaySummary').textContent")).includes('还没有记录'));

    console.log('\n[12] 无障碍与资源');
    const a11y = await evalPage(`(() => {
      const problems = [];
      document.querySelectorAll('input, select, button, a').forEach((c) => {
        if (c.type === 'hidden' || c.hidden) return;
        if (c.tagName === 'A' || c.tagName === 'BUTTON') {
          if (!(c.textContent.trim() || c.getAttribute('aria-label'))) problems.push(c.tagName + ' 缺少可读名称');
          return;
        }
        if (c.type === 'radio') {
          if (!c.closest('label')) problems.push('单选缺少 label 包裹');
          return;
        }
        if (!(c.id && document.querySelector('label[for="' + c.id + '"]')) && !c.getAttribute('aria-label')) problems.push('控件缺少 label:' + (c.id || c.name));
      });
      const svg = document.querySelector('#trendChart svg');
      if (svg && (!svg.getAttribute('role') || !svg.getAttribute('aria-label'))) problems.push('图表缺少 role/aria-label');
      const dlg = document.getElementById('confirmDialog');
      if (!dlg.getAttribute('aria-labelledby')) problems.push('弹窗缺少 aria-labelledby');
      return { problems, lang: document.documentElement.lang, skip: !!document.querySelector('.skip-link') };
    })()`);
    check('表单控件都有可访问名称', a11y.problems.length === 0, JSON.stringify(a11y.problems));
    check('页面声明中文语言', a11y.lang === 'zh-CN');
    check('提供跳转到主内容的链接', a11y.skip === true);

    const external = await evalPage("performance.getEntriesByType('resource').map(e => e.name).filter(n => /^https?:/.test(n))");
    check('页面没有外部网络请求', external.length === 0, JSON.stringify(external));

    await evalPage("document.getElementById('btnExport').focus()");
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(100);
    const focusState = await evalPage(`(() => {
      const s = getComputedStyle(document.querySelector('.file-label'));
      return { active: document.activeElement && document.activeElement.id, outline: s.outlineWidth + ' ' + s.outlineStyle };
    })()`);
    check('Tab 键能移动焦点到下一个控件', focusState.active === 'importFile', JSON.stringify(focusState));
    check('键盘焦点有可见的 outline', focusState.outline.includes('3px') && focusState.outline.includes('solid'), focusState.outline);

    const finalErrors = pageErrors();
    check('全流程未出现脚本异常', finalErrors.length === 0, finalErrors.join(' | '));

    // 保存一份桌面截图供人工查看
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'browser-final.png'), Buffer.from(r.data, 'base64'));
    });
  } catch (err) {
    failures.push('测试执行中断:' + err.message);
    console.log('\nFAIL  测试执行中断\n      ' + err.message);
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n通过 ' + passed + ' 项' + (failures.length ? ',失败 ' + failures.length + ' 项' : ',全部通过'));
  console.log('测试截图(临时目录):' + SHOT_DIR);
  if (failures.length) {
    console.log('失败清单:\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})();
