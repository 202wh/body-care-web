/* =====================================================================
   好好照顾自己 · 核心逻辑(纯函数,不依赖 DOM)
   设计目的:
   1) 日期、校验、导入解析、统计等逻辑与界面分离,便于在 Node 中测试;
   2) 浏览器中挂到 window.CareCore;Node 中通过 module.exports 暴露。
   本文件不发起任何网络请求。
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var APP_ID = 'haohao-care';
  var VERSION = 1;

  // 真实数据与演示数据完全分开存放,避免互相污染。
  var STORAGE_KEYS = {
    real: 'haohao-care:v1:real',
    demo: 'haohao-care:v1:demo'
  };

  var LIMITS = {
    weight: { min: 20, max: 300, label: '体重', unit: 'kg' },
    waist: { min: 30, max: 200, label: '腰围', unit: 'cm' },
    sleep: { min: 0, max: 24, label: '睡眠', unit: '小时' },
    activity: { min: 0, max: 1440, label: '运动', unit: '分钟' }
  };

  var FIELDS = ['weight', 'waist', 'sleep', 'activity'];

  var MOODS = ['很好', '轻松', '平静', '疲惫', '烦躁', '低落'];

  var WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  var HABIT_NAME_MAX = 14;
  var HABIT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  /* ---------------- 日期工具(一律使用本地时间) ---------------- */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toDateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function parseKey(key) {
    if (typeof key !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    // 用中午 12 点构造,避开夏令时/时区边界造成的日期偏移
    var date = new Date(y, mo - 1, d, 12, 0, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
  }

  function isValidKey(key) {
    return !!parseKey(key);
  }

  function addDays(key, amount) {
    var d = parseKey(key);
    if (!d) return null;
    d.setDate(d.getDate() + amount);
    return toDateKey(d);
  }

  function diffDays(a, b) {
    var da = parseKey(a);
    var db = parseKey(b);
    if (!da || !db) return null;
    return Math.round((da.getTime() - db.getTime()) / 86400000);
  }

  function weekdayIndex(key) {
    var d = parseKey(key);
    if (!d) return null;
    return (d.getDay() + 6) % 7; // 周一 = 0
  }

  function startOfWeekKey(key) {
    var idx = weekdayIndex(key);
    if (idx === null) return null;
    return addDays(key, -idx);
  }

  function rangeKeys(endKey, count) {
    var out = [];
    if (!isValidKey(endKey) || !count || count < 1) return out;
    for (var i = count - 1; i >= 0; i--) out.push(addDays(endKey, -i));
    return out;
  }

  function todayKey(now) {
    return toDateKey(now ? new Date(now) : new Date());
  }

  function formatKeyCN(key) {
    var d = parseKey(key);
    if (!d) return String(key || '');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function formatWeekdayCN(key) {
    var idx = weekdayIndex(key);
    return idx === null ? '' : WEEKDAYS[idx];
  }

  function formatShortCN(key) {
    var d = parseKey(key);
    if (!d) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatKeyWithWeek(key) {
    return formatKeyCN(key) + ' ' + formatWeekdayCN(key);
  }

  /* ---------------- 数值与表单校验 ---------------- */

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function parseOptionalNumber(raw, field) {
    var lim = LIMITS[field];
    if (raw === null || raw === undefined) return { value: null, error: null };
    var s = String(raw).trim();
    if (s === '') return { value: null, error: null };
    if (!/^\d+(\.\d+)?$/.test(s)) {
      return { value: null, error: '请填写数字,例如 62.5' };
    }
    var n = Number(s);
    if (!isFinite(n)) return { value: null, error: '请填写数字' };
    if (n < lim.min || n > lim.max) {
      return { value: null, error: lim.label + '请填写 ' + lim.min + '–' + lim.max + ' ' + lim.unit + ' 之间的数字' };
    }
    return { value: field === 'activity' ? Math.round(n) : round1(n), error: null };
  }

  /**
   * 校验一条日记录。所有身体数据都可留空,但整条记录至少要有一项内容。
   * @param {{date:string, weight:string, waist:string, sleep:string, activity:string, mood:string}} input
   * @param {string} today YYYY-MM-DD
   */
  function validateEntryForm(input, today) {
    var errors = {};
    var value = { date: null, weight: null, waist: null, sleep: null, activity: null, mood: null };

    var date = (input && input.date ? String(input.date) : '').trim();
    if (!date) {
      errors.date = '请选择日期';
    } else if (!isValidKey(date)) {
      errors.date = '日期格式不正确,请重新选择';
    } else if (today && date > today) {
      errors.date = '不能记录今天以后的日期';
    } else {
      value.date = date;
    }

    FIELDS.forEach(function (field) {
      var res = parseOptionalNumber(input ? input[field] : '', field);
      if (res.error) errors[field] = res.error;
      else value[field] = res.value;
    });

    var mood = input && input.mood ? String(input.mood) : '';
    if (mood && MOODS.indexOf(mood) === -1) {
      errors.mood = '心情选项无法识别';
    } else if (mood) {
      value.mood = mood;
    }

    var hasContent = FIELDS.some(function (field) { return value[field] !== null; }) || value.mood !== null;
    if (!hasContent && Object.keys(errors).length === 0) {
      errors.form = '至少填写一项再保存。体重、腰围、睡眠、运动都可以留空。';
    }

    return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
  }

  /* ---------------- 数据模型 ---------------- */

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyStore(iso) {
    var stamp = iso || nowIso();
    return {
      app: APP_ID,
      version: VERSION,
      demo: false,
      entries: {},
      habits: [],
      habitChecks: {},
      meta: { createdAt: stamp, updatedAt: stamp }
    };
  }

  function touch(store, iso) {
    if (!store.meta) store.meta = { createdAt: iso || nowIso(), updatedAt: iso || nowIso() };
    store.meta.updatedAt = iso || nowIso();
    return store;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clampList(list) {
    if (list.length <= 8) return list;
    return list.slice(0, 8).concat(['……以及另外 ' + (list.length - 8) + ' 个问题']);
  }

  /**
   * 校验并清洗导入的数据,严格模式下任何问题都会整体拒绝,避免半坏数据写入。
   * @param {*} raw 备份对象(payload 或裸 store 均可)
   * @param {string|null} today 传 null 表示不检查未来日期(读取本地存储时使用)
   */
  function sanitizeStore(raw, today) {
    var problems = [];
    if (!isPlainObject(raw)) {
      return { ok: false, problems: ['备份内容不是一个对象,无法识别'], store: null };
    }

    var isPayload = isPlainObject(raw.data) && (raw.app !== undefined || raw.exportedAt !== undefined);
    var data = isPayload ? raw.data : raw;

    if (raw.app !== undefined && raw.app !== APP_ID) {
      problems.push('这不是「好好照顾自己」导出的备份文件');
    }
    if (raw.version !== undefined && Number(raw.version) !== VERSION) {
      problems.push('备份版本 ' + raw.version + ' 暂不支持(当前支持版本 ' + VERSION + ')');
    }
    if (problems.length) {
      return { ok: false, problems: problems, store: null };
    }

    var entries = data.entries;
    var cleanedEntries = {};
    if (!isPlainObject(entries)) {
      problems.push('备份里没有找到可用的记录数据');
    } else {
      var keys = Object.keys(entries);
      if (keys.length > 4000) problems.push('记录数量超出可导入范围(最多 4000 天)');
      keys.forEach(function (key) {
        if (!isValidKey(key)) {
          problems.push('记录日期格式不正确:' + key);
          return;
        }
        if (today && key > today) {
          problems.push(formatKeyCN(key) + ' 是未来的日期,不能导入');
          return;
        }
        var entry = entries[key];
        if (!isPlainObject(entry)) {
          problems.push(formatKeyCN(key) + ' 的记录格式不正确');
          return;
        }
        var clean = {};
        var bad = false;
        FIELDS.forEach(function (field) {
          var v = entry[field];
          if (v === undefined || v === null) return;
          var lim = LIMITS[field];
          if (typeof v !== 'number' || !isFinite(v) || v < lim.min || v > lim.max) {
            problems.push(formatKeyCN(key) + ' 的' + lim.label + '应在 ' + lim.min + '–' + lim.max + ' ' + lim.unit + ' 之间');
            bad = true;
          } else {
            clean[field] = v;
          }
        });
        if (entry.mood !== undefined && entry.mood !== null) {
          if (MOODS.indexOf(entry.mood) === -1) {
            problems.push(formatKeyCN(key) + ' 的心情选项无法识别');
            bad = true;
          } else {
            clean.mood = entry.mood;
          }
        }
        if (!bad && Object.keys(clean).length) cleanedEntries[key] = clean;
      });
    }

    var cleanedHabits = [];
    if (data.habits !== undefined && data.habits !== null) {
      if (!Array.isArray(data.habits)) {
        problems.push('习惯数据格式不正确');
      } else if (data.habits.length > 40) {
        problems.push('习惯数量超出上限(最多 40 个)');
      } else {
        var seenIds = {};
        data.habits.forEach(function (h, i) {
          if (!isPlainObject(h)) {
            problems.push('第 ' + (i + 1) + ' 个习惯格式不正确');
            return;
          }
          var id = h.id;
          var name = h.name;
          var target = h.targetPerWeek;
          if (typeof id !== 'string' || !HABIT_ID_RE.test(id)) {
            problems.push('第 ' + (i + 1) + ' 个习惯的编号格式不正确');
            return;
          }
          if (seenIds[id]) {
            problems.push('习惯编号重复:' + id);
            return;
          }
          if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > HABIT_NAME_MAX) {
            problems.push('第 ' + (i + 1) + ' 个习惯的名称应为 1–' + HABIT_NAME_MAX + ' 个字');
            return;
          }
          if (typeof target !== 'number' || target < 1 || target > 7 || Math.floor(target) !== target) {
            problems.push('习惯「' + name.trim() + '」的每周目标应为 1–7 的整数');
            return;
          }
          seenIds[id] = true;
          cleanedHabits.push({ id: id, name: name.trim(), targetPerWeek: target });
        });
      }
    }

    var habitIds = {};
    cleanedHabits.forEach(function (h) { habitIds[h.id] = true; });

    var cleanedChecks = {};
    if (data.habitChecks !== undefined && data.habitChecks !== null) {
      if (!isPlainObject(data.habitChecks)) {
        problems.push('打卡数据格式不正确');
      } else {
        Object.keys(data.habitChecks).forEach(function (key) {
          if (!isValidKey(key)) {
            problems.push('打卡日期格式不正确:' + key);
            return;
          }
          if (today && key > today) {
            problems.push(formatKeyCN(key) + ' 有未来的打卡记录,不能导入');
            return;
          }
          var list = data.habitChecks[key];
          if (!Array.isArray(list)) {
            problems.push(formatKeyCN(key) + ' 的打卡数据格式不正确');
            return;
          }
          var ids = [];
          list.forEach(function (id) {
            // 习惯被删除后残留的编号直接忽略,不阻断导入
            if (typeof id === 'string' && habitIds[id] && ids.indexOf(id) === -1) ids.push(id);
          });
          if (ids.length) cleanedChecks[key] = ids;
        });
      }
    }

    if (problems.length) {
      return { ok: false, problems: clampList(problems), store: null };
    }

    var meta = isPlainObject(data.meta) ? data.meta : {};
    var stamp = nowIso();
    var store = {
      app: APP_ID,
      version: VERSION,
      demo: data.demo === true || raw.demo === true,
      entries: cleanedEntries,
      habits: cleanedHabits,
      habitChecks: cleanedChecks,
      meta: {
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : stamp,
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : stamp
      }
    };
    return { ok: true, problems: [], store: store };
  }

  function buildExportPayload(store, exportedAt) {
    return {
      app: APP_ID,
      version: VERSION,
      exportedAt: exportedAt || nowIso(),
      demo: !!store.demo,
      data: {
        entries: store.entries || {},
        habits: store.habits || [],
        habitChecks: store.habitChecks || {},
        meta: store.meta || {}
      }
    };
  }

  function countDays(store) {
    return Object.keys(store.entries || {}).length;
  }

  /** 合并:同一天以导入文件为准,习惯按编号合并,打卡记录取并集 */
  function mergeStores(base, incoming, iso) {
    var merged = createEmptyStore(iso);
    merged.demo = false;

    var entries = {};
    Object.keys(base.entries || {}).forEach(function (k) { entries[k] = base.entries[k]; });
    Object.keys(incoming.entries || {}).forEach(function (k) {
      entries[k] = incoming.entries[k];
      if (entries[k]) entries[k] = Object.assign({}, base.entries[k] || {}, entries[k]);
    });
    merged.entries = entries;

    var byId = {};
    var order = [];
    (base.habits || []).forEach(function (h) {
      byId[h.id] = { id: h.id, name: h.name, targetPerWeek: h.targetPerWeek };
      order.push(h.id);
    });
    (incoming.habits || []).forEach(function (h) {
      byId[h.id] = { id: h.id, name: h.name, targetPerWeek: h.targetPerWeek };
      if (order.indexOf(h.id) === -1) order.push(h.id);
    });
    merged.habits = order.map(function (id) { return byId[id]; });

    var validIds = {};
    merged.habits.forEach(function (h) { validIds[h.id] = true; });

    var checks = {};
    [base.habitChecks || {}, incoming.habitChecks || {}].forEach(function (source) {
      Object.keys(source).forEach(function (key) {
        var list = checks[key] || [];
        source[key].forEach(function (id) {
          if (validIds[id] && list.indexOf(id) === -1) list.push(id);
        });
        if (list.length) checks[key] = list;
      });
    });
    merged.habitChecks = checks;

    merged.meta.createdAt = (base.meta && base.meta.createdAt) || nowIso();
    merged.meta.updatedAt = iso || nowIso();
    return merged;
  }

  /* ---------------- 统计 ---------------- */

  function summarizeWeights(entries, keys) {
    var points = [];
    (keys || []).forEach(function (key) {
      var e = entries ? entries[key] : null;
      if (e && typeof e.weight === 'number' && isFinite(e.weight)) {
        points.push({ key: key, value: e.weight });
      }
    });
    if (!points.length) {
      return { count: 0, avg: null, min: null, max: null, first: null, last: null, change: null, points: points };
    }
    var sum = 0;
    var min = points[0].value;
    var max = points[0].value;
    points.forEach(function (p) {
      sum += p.value;
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    });
    return {
      count: points.length,
      avg: round1(sum / points.length),
      min: min,
      max: max,
      first: points[0],
      last: points[points.length - 1],
      change: round1(points[points.length - 1].value - points[0].value),
      points: points
    };
  }

  function latestField(entries, field, keys) {
    var found = null;
    (keys || []).forEach(function (key) {
      var e = entries ? entries[key] : null;
      if (e && typeof e[field] === 'number' && isFinite(e[field])) found = { key: key, value: e[field] };
    });
    return found;
  }

  function habitChecksOn(store, key) {
    return (store.habitChecks && store.habitChecks[key]) || [];
  }

  function habitProgress(store, habitId, keys) {
    var done = 0;
    (keys || []).forEach(function (key) {
      if (habitChecksOn(store, key).indexOf(habitId) !== -1) done += 1;
    });
    return done;
  }

  function weeklyReview(store, weekKeys) {
    var daysWithAny = 0;
    var weightDays = 0;
    var weightSum = 0;
    var activitySum = 0;
    var activityDays = 0;
    var sleepSum = 0;
    var sleepDays = 0;
    var waistLatest = null;

    (weekKeys || []).forEach(function (key) {
      var e = (store.entries || {})[key];
      if (!e) return;
      var any = false;
      if (typeof e.weight === 'number') { any = true; weightDays += 1; weightSum += e.weight; }
      if (typeof e.activity === 'number') { any = true; activityDays += 1; activitySum += e.activity; }
      if (typeof e.sleep === 'number') { any = true; sleepDays += 1; sleepSum += e.sleep; }
      if (typeof e.waist === 'number') { any = true; waistLatest = { key: key, value: e.waist }; }
      if (e.mood) any = true;
      if (any) daysWithAny += 1;
    });

    var habitDone = 0;
    var habitTarget = 0;
    (store.habits || []).forEach(function (h) {
      habitTarget += h.targetPerWeek;
      habitDone += habitProgress(store, h.id, weekKeys);
    });

    return {
      daysWithAny: daysWithAny,
      weightDays: weightDays,
      weightAvg: weightDays ? round1(weightSum / weightDays) : null,
      activitySum: activitySum,
      activityDays: activityDays,
      sleepAvg: sleepDays ? round1(sleepSum / sleepDays) : null,
      sleepDays: sleepDays,
      waistLatest: waistLatest,
      habitDone: habitDone,
      habitTarget: habitTarget,
      habitCount: (store.habits || []).length
    };
  }

  /* ---------------- 存储 ---------------- */

  function makeRepository(storage, mode) {
    var key = mode === 'demo' ? STORAGE_KEYS.demo : STORAGE_KEYS.real;
    return {
      key: key,
      mode: mode === 'demo' ? 'demo' : 'real',
      available: function () {
        if (!storage) return false;
        try {
          var probe = '__haohao_probe__';
          storage.setItem(probe, '1');
          storage.removeItem(probe);
          return true;
        } catch (err) {
          return false;
        }
      },
      /** @returns {{store: object|null, raw: string|null, error: string|null}} */
      load: function () {
        if (!storage) return { store: null, raw: null, error: '当前浏览器不允许本地保存' };
        var raw = null;
        try {
          raw = storage.getItem(key);
        } catch (err) {
          return { store: null, raw: null, error: '读取本地数据失败' };
        }
        if (!raw) return { store: null, raw: null, error: null };
        var parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          return { store: null, raw: raw, error: '本地数据的 JSON 格式已损坏' };
        }
        var res = sanitizeStore(parsed, null);
        if (!res.ok) {
          return { store: null, raw: raw, error: '本地数据无法识别:' + res.problems.join(';') };
        }
        return { store: res.store, raw: raw, error: null };
      },
      save: function (store) {
        if (!storage) return { ok: false, error: '当前浏览器不允许本地保存' };
        try {
          storage.setItem(key, JSON.stringify(store));
          return { ok: true, error: null };
        } catch (err) {
          return { ok: false, error: '保存失败,可能是浏览器存储空间不足或被禁用' };
        }
      },
      clear: function () {
        if (!storage) return { ok: false, error: '当前浏览器不允许本地保存' };
        try {
          storage.removeItem(key);
          return { ok: true, error: null };
        } catch (err) {
          return { ok: false, error: '清空失败' };
        }
      }
    };
  }

  /* ---------------- 演示数据(仅写入 demo 存储键) ---------------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t + Math.imul(t ^ (t >>> 7), t | 61) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildDemoStore(today) {
    var todayKeyStr = today || todayKey();
    var rng = mulberry32(20261126);
    var store = createEmptyStore();
    store.demo = true;

    var days = 26;
    var keys = rangeKeys(todayKeyStr, days);

    var weight = 68.4;
    var activities = [0, 20, 25, 30, 35, 40, 45, 50];
    var sleeps = [6.4, 6.8, 7.1, 7.3, 7.6, 7.9, 8.2];

    keys.forEach(function (key, i) {
      var entry = {};
      weight = weight - 0.12 + (rng() - 0.5) * 0.5;
      var idx = weekdayIndex(key);

      // 体重:隔天记录一次,并故意留几天空白,演示"不必天天填"
      if (i % 3 !== 1) entry.weight = round1(weight);
      // 腰围:每 7 天一次
      if (i % 7 === 2) entry.waist = round1(83.5 - i * 0.12 + rng() * 0.4);
      // 睡眠:大多数天有,周末略多
      if (i % 5 !== 3) entry.sleep = round1(sleeps[Math.min(sleeps.length - 1, Math.floor(rng() * sleeps.length))] + (idx >= 5 ? 0.3 : 0));
      // 运动:留出完全没记录的日子
      if (i % 4 !== 0) entry.activity = activities[Math.floor(rng() * activities.length)];
      // 心情:循环几种
      if (i % 2 === 0) entry.mood = MOODS[i % MOODS.length];

      if (Object.keys(entry).length) store.entries[key] = entry;
    });

    store.habits = [
      { id: 'demo-meal', name: '规律吃饭', targetPerWeek: 5 },
      { id: 'demo-veg', name: '一份蔬果', targetPerWeek: 5 },
      { id: 'demo-move', name: '动一动', targetPerWeek: 3 },
      { id: 'demo-rest', name: '早点放下手机', targetPerWeek: 4 }
    ];

    keys.forEach(function (key) {
      var checks = [];
      store.habits.forEach(function (h, hi) {
        var p = [0.72, 0.6, 0.45, 0.4][hi];
        if (rng() < p) checks.push(h.id);
      });
      if (checks.length) store.habitChecks[key] = checks;
    });

    store.meta.createdAt = nowIso();
    store.meta.updatedAt = nowIso();
    return store;
  }

  return {
    APP_ID: APP_ID,
    VERSION: VERSION,
    STORAGE_KEYS: STORAGE_KEYS,
    LIMITS: LIMITS,
    FIELDS: FIELDS,
    MOODS: MOODS,
    WEEKDAYS: WEEKDAYS,
    HABIT_NAME_MAX: HABIT_NAME_MAX,
    toDateKey: toDateKey,
    parseKey: parseKey,
    isValidKey: isValidKey,
    addDays: addDays,
    diffDays: diffDays,
    weekdayIndex: weekdayIndex,
    startOfWeekKey: startOfWeekKey,
    rangeKeys: rangeKeys,
    todayKey: todayKey,
    formatKeyCN: formatKeyCN,
    formatWeekdayCN: formatWeekdayCN,
    formatShortCN: formatShortCN,
    formatKeyWithWeek: formatKeyWithWeek,
    round1: round1,
    parseOptionalNumber: parseOptionalNumber,
    validateEntryForm: validateEntryForm,
    createEmptyStore: createEmptyStore,
    touch: touch,
    sanitizeStore: sanitizeStore,
    buildExportPayload: buildExportPayload,
    mergeStores: mergeStores,
    countDays: countDays,
    summarizeWeights: summarizeWeights,
    latestField: latestField,
    habitChecksOn: habitChecksOn,
    habitProgress: habitProgress,
    weeklyReview: weeklyReview,
    makeRepository: makeRepository,
    buildDemoStore: buildDemoStore
  };
});
