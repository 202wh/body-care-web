/* 零依赖自测脚本:node tests/core.test.js
   只测试纯逻辑(日期、校验、导入清洗、统计、存储隔离),不伪造浏览器测试结果。 */
'use strict';

const assert = require('node:assert/strict');
const Core = require('../assets/core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    console.log('FAIL  ' + name);
    console.log('      ' + err.message);
    process.exitCode = 1;
  }
}

const TODAY = '2026-11-26';

console.log('\n[1] 日期处理');
test('合法日期通过', () => {
  assert.equal(Core.isValidKey('2026-11-26'), true);
  assert.equal(Core.isValidKey('2024-02-29'), true);
});
test('不存在的日期被拒绝', () => {
  assert.equal(Core.isValidKey('2026-02-30'), false);
  assert.equal(Core.isValidKey('2026-13-01'), false);
  assert.equal(Core.isValidKey('2026-2-3'), false);
  assert.equal(Core.isValidKey(''), false);
  assert.equal(Core.isValidKey(null), false);
});
test('跨月跨年加减日期', () => {
  assert.equal(Core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(Core.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(Core.addDays('2024-03-01', -1), '2024-02-29');
});
test('周一为一周起点', () => {
  assert.equal(Core.weekdayIndex('2026-11-26'), 3);
  assert.equal(Core.startOfWeekKey('2026-11-26'), '2026-11-23');
  assert.equal(Core.startOfWeekKey('2026-11-23'), '2026-11-23');
  assert.equal(Core.startOfWeekKey('2026-11-29'), '2026-11-23');
});
test('最近 7/30 天范围长度与终点正确', () => {
  const k7 = Core.rangeKeys(TODAY, 7);
  assert.equal(k7.length, 7);
  assert.equal(k7[0], '2026-11-20');
  assert.equal(k7[6], TODAY);
  const k30 = Core.rangeKeys(TODAY, 30);
  assert.equal(k30.length, 30);
  assert.equal(Core.diffDays(k30[0], TODAY), -29);
});

console.log('\n[2] 表单校验与错误输入');
test('全部留空时给出整体提示', () => {
  const r = Core.validateEntryForm({ date: TODAY }, TODAY);
  assert.equal(r.ok, false);
  assert.equal(typeof r.errors.form, 'string');
});
test('未来日期被拒绝', () => {
  const r = Core.validateEntryForm({ date: '2026-11-27', weight: '62' }, TODAY);
  assert.equal(r.ok, false);
  assert.match(r.errors.date, /今天以后/);
});
test('非数字与超范围数值被拒绝', () => {
  assert.ok(Core.parseOptionalNumber('abc', 'weight').error);
  assert.ok(Core.parseOptionalNumber('62kg', 'weight').error);
  assert.ok(Core.parseOptionalNumber('-5', 'weight').error);
  assert.ok(Core.parseOptionalNumber('500', 'weight').error);
  assert.ok(Core.parseOptionalNumber('25', 'waist').error);
  assert.ok(Core.parseOptionalNumber('30', 'sleep').error);
  assert.ok(Core.parseOptionalNumber('2000', 'activity').error);
});
test('合法记录被整理为数字', () => {
  const r = Core.validateEntryForm(
    { date: TODAY, weight: '62.34', waist: '78', sleep: '7.5', activity: '45', mood: '平静' },
    TODAY
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.weight, 62.3);
  assert.equal(r.value.activity, 45);
  assert.equal(r.value.mood, '平静');
});
test('只填心情也能保存', () => {
  const r = Core.validateEntryForm({ date: TODAY, mood: '疲惫' }, TODAY);
  assert.equal(r.ok, true);
});
test('未知心情被拒绝', () => {
  const r = Core.validateEntryForm({ date: TODAY, mood: '狂喜' }, TODAY);
  assert.equal(r.ok, false);
  assert.ok(r.errors.mood);
});
test('日期为空被拒绝', () => {
  const r = Core.validateEntryForm({ date: '', weight: '60' }, TODAY);
  assert.equal(r.ok, false);
  assert.ok(r.errors.date);
});

console.log('\n[3] 导入清洗(JSON 结构与数值)');
function makeStore() {
  const s = Core.createEmptyStore('2026-11-26T00:00:00.000Z');
  s.entries['2026-11-25'] = { weight: 62.3, sleep: 7, mood: '平静' };
  s.entries['2026-11-24'] = { activity: 30 };
  s.habits = [{ id: 'h-1', name: '规律吃饭', targetPerWeek: 5 }];
  s.habitChecks = { '2026-11-25': ['h-1'] };
  return s;
}
test('导出再导入保持一致', () => {
  const payload = Core.buildExportPayload(makeStore(), '2026-11-26T01:00:00.000Z');
  const res = Core.sanitizeStore(JSON.parse(JSON.stringify(payload)), TODAY);
  assert.equal(res.ok, true);
  assert.equal(res.store.entries['2026-11-25'].weight, 62.3);
  assert.equal(res.store.habits[0].name, '规律吃饭');
  assert.deepEqual(res.store.habitChecks['2026-11-25'], ['h-1']);
  assert.equal(Core.countDays(res.store), 2);
});
test('其他应用的备份被拒绝', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.app = 'other-app';
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /不是「好好照顾自己」/);
});
test('版本不支持被拒绝', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.version = 9;
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /版本/);
});
test('坏日期与超范围数值被列出', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.data.entries['2026-02-30'] = { weight: 60 };
  payload.data.entries['2026-11-20'] = { weight: 5000 };
  payload.data.entries['2026-11-28'] = { sleep: 8 };
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
  assert.equal(res.store, null);
  const msg = res.problems.join(' ');
  assert.match(msg, /日期格式不正确/);
  assert.match(msg, /体重应在 20–300/);
  assert.match(msg, /未来/);
});
test('损坏的打卡结构被拒绝', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.data.habitChecks['2026-11-25'] = 'h-1';
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /打卡数据格式不正确/);
});
test('没有记录数据的对象被拒绝', () => {
  const res = Core.sanitizeStore({ hello: 'world' }, TODAY);
  assert.equal(res.ok, false);
});
test('读取本地存储时不检查未来日期(防止时钟回拨丢数据)', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.data.entries['2026-12-05'] = { weight: 61 };
  const res = Core.sanitizeStore(payload, null);
  assert.equal(res.ok, true);
  assert.ok(res.store.entries['2026-12-05']);
});

console.log('\n[4] 趋势与每周复盘');
test('无体重数据时返回空结果', () => {
  const s = Core.summarizeWeights({}, Core.rangeKeys(TODAY, 7));
  assert.equal(s.count, 0);
  assert.equal(s.avg, null);
  assert.equal(s.points.length, 0);
});
test('体重统计只取范围内有记录的日期', () => {
  const entries = {
    '2026-11-20': { weight: 62.0 },
    '2026-11-24': { weight: 63.0 },
    '2026-11-26': { weight: 62.5 },
    '2026-11-10': { weight: 70 } // 超出 7 天范围
  };
  const s = Core.summarizeWeights(entries, Core.rangeKeys(TODAY, 7));
  assert.equal(s.count, 3);
  assert.equal(s.avg, 62.5);
  assert.equal(s.min, 62);
  assert.equal(s.max, 63);
  assert.equal(s.change, 0.5);
});
test('每周复盘统计记录天数、习惯、运动与睡眠', () => {
  const s = makeStore();
  s.entries['2026-11-23'] = { weight: 62, activity: 20, sleep: 7 };
  s.entries['2026-11-24'] = { activity: 30, sleep: 6 };
  s.habitChecks['2026-11-24'] = ['h-1'];
  const week = Core.rangeKeys(TODAY, 7);
  const r = Core.weeklyReview(s, week);
  assert.equal(r.daysWithAny, 3);
  assert.equal(r.weightDays, 2);
  assert.equal(r.activitySum, 50);
  assert.equal(r.sleepAvg, 6.7);
  assert.equal(r.habitDone, 2);
  assert.equal(r.habitTarget, 5);
});

console.log('\n[5] 存储隔离与持久化(用内存假存储模拟 localStorage)');
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}
test('真实数据与演示数据写在不同键', () => {
  const storage = fakeStorage();
  const real = Core.makeRepository(storage, 'real');
  const demo = Core.makeRepository(storage, 'demo');
  assert.equal(real.key, 'haohao-care:v1:real');
  assert.equal(demo.key, 'haohao-care:v1:demo');

  const s = Core.createEmptyStore();
  s.entries[TODAY] = { weight: 61 };
  assert.equal(real.save(s).ok, true);

  assert.equal(demo.load().store, null, '演示模式不应读到真实数据');
  assert.equal(real.load().store.entries[TODAY].weight, 61);
});
test('清空演示数据不影响真实数据', () => {
  const storage = fakeStorage();
  const real = Core.makeRepository(storage, 'real');
  const demo = Core.makeRepository(storage, 'demo');
  const s = Core.createEmptyStore();
  s.entries[TODAY] = { weight: 61 };
  real.save(s);
  demo.save(Core.buildDemoStore(TODAY));
  demo.clear();
  assert.equal(demo.load().store, null);
  assert.equal(real.load().store.entries[TODAY].weight, 61);
});
test('存储为空时返回空状态而不是报错', () => {
  const repo = Core.makeRepository(fakeStorage(), 'real');
  assert.deepEqual(repo.load(), { store: null, raw: null, error: null });
});
test('存储 JSON 损坏时给出错误并保留原始内容', () => {
  const storage = fakeStorage();
  storage.setItem('haohao-care:v1:real', '{not json');
  const res = Core.makeRepository(storage, 'real').load();
  assert.equal(res.store, null);
  assert.match(res.error, /JSON/);
  assert.equal(res.raw, '{not json');
});
test('localStorage 不可用时不抛异常', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  const repo = Core.makeRepository(broken, 'real');
  assert.equal(repo.available(), false);
  assert.equal(repo.save(Core.createEmptyStore()).ok, false);
  assert.ok(repo.load().error);
});

console.log('\n[6] 合并导入与演示数据');
test('合并时同一天以导入文件为准,其余保留', () => {
  const base = Core.createEmptyStore();
  base.entries['2026-11-24'] = { weight: 62, activity: 20 };
  base.entries['2026-11-25'] = { sleep: 7 };
  base.habits = [{ id: 'h-1', name: '老习惯', targetPerWeek: 3 }];

  const incoming = Core.createEmptyStore();
  incoming.entries['2026-11-24'] = { weight: 63 };
  incoming.entries['2026-11-26'] = { activity: 30 };
  incoming.habits = [
    { id: 'h-1', name: '改过的习惯', targetPerWeek: 5 },
    { id: 'h-2', name: '新习惯', targetPerWeek: 2 }
  ];
  incoming.habitChecks = { '2026-11-26': ['h-2'] };

  const m = Core.mergeStores(base, incoming, '2026-11-26T02:00:00.000Z');
  assert.equal(m.entries['2026-11-24'].weight, 63);
  assert.equal(m.entries['2026-11-24'].activity, 20, '导入文件没写的字段保留原值');
  assert.ok(m.entries['2026-11-25']);
  assert.ok(m.entries['2026-11-26']);
  assert.equal(m.habits.length, 2);
  assert.equal(m.habits[0].targetPerWeek, 5);
  assert.deepEqual(m.habitChecks['2026-11-26'], ['h-2']);
});
test('演示数据在当天范围内且标记为演示', () => {
  const demo = Core.buildDemoStore(TODAY);
  assert.equal(demo.demo, true);
  const keys = Object.keys(demo.entries);
  assert.ok(keys.length > 10);
  assert.equal(keys.every((k) => k <= TODAY && Core.isValidKey(k)), true);
  assert.equal(demo.habits.length, 4);
  const re = Core.sanitizeStore(JSON.parse(JSON.stringify(Core.buildExportPayload(demo))), TODAY);
  assert.equal(re.ok, true);
  assert.equal(re.store.demo, true);
});

console.log('\n[7] 空数据与边界');
test('空 store 通过校验', () => {
  const res = Core.sanitizeStore(Core.createEmptyStore(), TODAY);
  assert.equal(res.ok, true);
  assert.equal(Core.countDays(res.store), 0);
});
test('习惯目标必须是 1–7 的整数', () => {
  const payload = Core.buildExportPayload(Core.createEmptyStore());
  payload.data.habits = [{ id: 'h-1', name: '测试', targetPerWeek: 1.5 }];
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
});
test('打卡日期不能是未来', () => {
  const payload = Core.buildExportPayload(makeStore());
  payload.data.habitChecks['2026-12-01'] = ['h-1'];
  const res = Core.sanitizeStore(payload, TODAY);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /未来的打卡/);
});

console.log('\n共通过 ' + passed + ' 项检查' + (process.exitCode ? ',存在失败项' : ',全部通过') + '\n');
