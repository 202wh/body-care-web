/* =====================================================================
   好好照顾自己 · 页面交互
   依赖 assets/core.js(纯逻辑),不引入任何外部库,不发起网络请求。
   数据只写入浏览器 localStorage。
   ===================================================================== */
(function () {
  'use strict';

  var Core = window.CareCore;
  if (!Core) return;

  var SMALL_THINGS = [
    '吃饭的时候把手机放远一点,只看眼前这一餐。',
    '出门前伸几个懒腰,让肩颈松一松。',
    '给今天的一餐加一份蔬菜,不用称重量。',
    '睡前把灯调暗,提前十分钟放下手机。',
    '走一小段路,不必计步,走到身上微微发热就好。',
    '喝一杯水,不是任务,只是顺手。',
    '坐久了就站起来走两步,顺便去接一杯水。',
    '今天少刷一会儿手机,把这点时间留给发呆。',
    '吃饭慢一点,尝出味道再咽下去。',
    '把明天要穿的衣服先放好,早上少一点慌。',
    '通勤时提前一站下车,慢慢走回去。',
    '午休时闭眼十分钟,不睡也算休息。'
  ];
  var MOODS = Core.MOODS;

  var el = {};
  var TODAY = Core.todayKey();
  var mode = 'real';
  var repo = null;
  var state = Core.createEmptyStore();
  var editingKey = TODAY;
  var trendRange = 7;
  var thingOffset = 0;
  var loadWarning = null;
  var rawBackup = null;
  var toastTimer = null;

  /* ---------------- 小工具 ---------------- */

  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return String(n);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function cacheEls() {
    [
      'heroDate', 'smallThingText', 'btnAnotherThing',
      'entryForm', 'entryDate', 'fWeight', 'fWaist', 'fSleep', 'fActivity',
      'moodChips', 'formErrors', 'btnSave', 'btnResetForm', 'btnDeleteEntry',
      'entryStatus', 'todaySummary',
      'habitForm', 'habitName', 'habitTarget', 'habitErrors', 'habitList', 'habitEmpty',
      'habitSuggestions',
      'trendChart', 'trendStats', 'trendSummary', 'range7', 'range30',
      'reviewIntro', 'reviewLines', 'reviewNote',
      'btnExport', 'importFile', 'btnDemoOn', 'btnDemoOff', 'btnClear',
      'storageState', 'demoBanner',
      'confirmDialog', 'dialogTitle', 'dialogContent', 'dialogActions',
      'toast'
    ].forEach(function (id) { el[id] = byId(id); });
  }

  function getStorage() {
    try {
      var s = window.localStorage;
      var probe = '__haohao_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (err) {
      return null;
    }
  }

  /* ---------------- 启动 ---------------- */

  var storage = null;

  function boot() {
    cacheEls();
    if (!el.entryForm) return;
    storage = getStorage();
    repo = Core.makeRepository(storage, 'real');
    document.body.classList.remove('is-demo');

    el.entryDate.max = TODAY;
    el.entryDate.value = TODAY;
    editingKey = TODAY;

    var res = repo.load();
    state = res.store || Core.createEmptyStore();
    loadWarning = res.error;
    rawBackup = res.raw;

    bindEvents();
    renderAll();
    populateForm(TODAY);
    if (loadWarning) toast('读取本地记录遇到问题,请查看“数据”一节的说明');
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    document.body.classList.toggle('is-demo', mode === 'demo');
    renderHero();
    renderTodaySummary();
    updateFormMeta();
    renderHabits();
    renderTrend();
    renderReview();
    renderStorageState();
  }

  function renderHero() {
    el.heroDate.textContent = '今天是 ' + Core.formatKeyWithWeek(TODAY) + ' · 慢慢来就好';
    renderSmallThing();
  }

  function renderSmallThing() {
    var yearStart = String(TODAY).slice(0, 4) + '-01-01';
    var dayIndex = Math.max(0, Core.diffDays(TODAY, yearStart) || 0);
    var idx = (dayIndex + thingOffset) % SMALL_THINGS.length;
    el.smallThingText.textContent = SMALL_THINGS[idx];
  }

  function entryParts(e) {
    var parts = [];
    if (!e) return parts;
    if (typeof e.weight === 'number') parts.push('体重 ' + fmtNum(e.weight) + ' kg');
    if (typeof e.waist === 'number') parts.push('腰围 ' + fmtNum(e.waist) + ' cm');
    if (typeof e.sleep === 'number') parts.push('睡眠 ' + fmtNum(e.sleep) + ' 小时');
    if (typeof e.activity === 'number') parts.push('运动 ' + fmtNum(e.activity) + ' 分钟');
    if (e.mood) parts.push('心情 ' + e.mood);
    return parts;
  }

  function renderTodaySummary() {
    var parts = entryParts(state.entries[TODAY]);
    if (!parts.length) {
      el.todaySummary.textContent = '今天还没有记录。想记就记,不想记也没关系。';
      return;
    }
    el.todaySummary.innerHTML = '<span class="muted">今天记了:</span>' +
      parts.map(function (p) { return '<span class="pill">' + esc(p) + '</span>'; }).join('');
  }

  function setMood(mood) {
    var inputs = el.moodChips.querySelectorAll('input[name="mood"]');
    Array.prototype.forEach.call(inputs, function (input) {
      input.checked = (input.value === (mood || ''));
    });
  }

  function getMood() {
    var checked = el.moodChips.querySelector('input[name="mood"]:checked');
    return checked ? checked.value : '';
  }

  function trimInput(n) {
    if (typeof n !== 'number') return '';
    return String(n);
  }

  function populateForm(key) {
    editingKey = key;
    var e = state.entries[key];
    el.entryDate.value = key;
    el.fWeight.value = e ? trimInput(e.weight) : '';
    el.fWaist.value = e ? trimInput(e.waist) : '';
    el.fSleep.value = e ? trimInput(e.sleep) : '';
    el.fActivity.value = e ? trimInput(e.activity) : '';
    setMood(e ? e.mood : '');
    clearFormErrors();
    updateFormMeta();
  }

  function updateFormMeta() {
    var has = !!state.entries[editingKey];
    el.btnSave.textContent = has ? '更新这天的记录' : '保存这天的记录';
    el.btnDeleteEntry.hidden = !has;
    var label = Core.formatKeyCN(editingKey);
    if (editingKey === TODAY) {
      el.entryStatus.textContent = has ? '今天已有记录,可以修改。' : '今天还没有记录。';
    } else {
      el.entryStatus.textContent = has ? '正在查看 ' + label + ' 的记录。' : label + ' 还没有记录。';
    }
  }

  function setStatus(text) {
    el.entryStatus.textContent = text;
  }

  /* ---------------- 表单错误 ---------------- */

  var FIELD_TO_INPUT = {
    date: 'entryDate',
    weight: 'fWeight',
    waist: 'fWaist',
    sleep: 'fSleep',
    activity: 'fActivity'
  };

  function clearFormErrors() {
    el.formErrors.dataset.active = 'false';
    el.formErrors.innerHTML = '';
    Object.keys(FIELD_TO_INPUT).forEach(function (field) {
      el[FIELD_TO_INPUT[field]].removeAttribute('aria-invalid');
    });
    el.moodChips.removeAttribute('aria-invalid');
  }

  function showFormErrors(errors) {
    clearFormErrors();
    var box = el.formErrors;
    var title = document.createElement('strong');
    title.textContent = '还需要检查一下:';
    box.appendChild(title);
    var ul = document.createElement('ul');

    Object.keys(errors).forEach(function (field) {
      var li = document.createElement('li');
      li.textContent = errors[field];
      ul.appendChild(li);
      var input = el[FIELD_TO_INPUT[field]];
      if (input) {
        input.setAttribute('aria-invalid', 'true');
      } else if (field === 'mood') {
        el.moodChips.setAttribute('aria-invalid', 'true');
      }
    });

    box.appendChild(ul);
    box.dataset.active = 'true';

    var firstField = Object.keys(errors).filter(function (f) { return FIELD_TO_INPUT[f]; })[0];
    if (firstField) {
      el[FIELD_TO_INPUT[firstField]].focus();
    } else if (errors.date) {
      el.entryDate.focus();
    } else {
      el.fWeight.focus();
    }
  }

  /* ---------------- 记录的保存、删除 ---------------- */

  function persist() {
    var res = repo.save(state);
    if (!res.ok) {
      toast((res.error || '保存失败') + ',这次修改只保留在当前页面里');
      return false;
    }
    return true;
  }

  function onSubmitEntry(ev) {
    ev.preventDefault();
    var input = {
      date: el.entryDate.value,
      weight: el.fWeight.value,
      waist: el.fWaist.value,
      sleep: el.fSleep.value,
      activity: el.fActivity.value,
      mood: getMood()
    };
    var res = Core.validateEntryForm(input, TODAY);
    if (!res.ok) {
      showFormErrors(res.errors);
      return;
    }
    clearFormErrors();

    var key = res.value.date;
    var entry = {};
    Core.FIELDS.forEach(function (field) {
      if (res.value[field] !== null) entry[field] = res.value[field];
    });
    if (res.value.mood) entry.mood = res.value.mood;

    state.entries[key] = entry;
    Core.touch(state);
    if (persist()) {
      toast('已保存 ' + Core.formatKeyCN(key) + ' 的记录');
    }
    renderAll();
    populateForm(key);
    var now = new Date();
    setStatus('已保存 · ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
  }

  function resetInputs() {
    el.fWeight.value = '';
    el.fWaist.value = '';
    el.fSleep.value = '';
    el.fActivity.value = '';
    setMood('');
    clearFormErrors();
    setStatus('输入框已清空;已保存的记录没有被改动。');
  }

  async function onDeleteEntry() {
    var key = editingKey;
    if (!state.entries[key]) return;
    var answer = await confirmBox({
      title: '删除这天的记录?',
      body: '<p>将删除 <strong>' + esc(Core.formatKeyWithWeek(key)) + '</strong> 的整条记录(包括体重、睡眠、心情等)。</p><p>删除后无法恢复,但其他日子的记录不受影响。</p>',
      confirmLabel: '删除这条记录',
      cancelLabel: '先留着',
      danger: true
    });
    if (!answer) return;
    delete state.entries[key];
    Core.touch(state);
    persist();
    renderAll();
    populateForm(key);
    setStatus('已删除 ' + Core.formatKeyCN(key) + ' 的记录。');
    toast('已删除 ' + Core.formatKeyCN(key) + ' 的记录');
  }

  /* ---------------- 习惯 ---------------- */

  function currentWeekKeys() {
    var start = Core.startOfWeekKey(TODAY);
    return Core.rangeKeys(Core.addDays(start, 6), 7);
  }

  function renderHabits() {
    var list = el.habitList;
    if (!state.habits.length) {
      list.innerHTML = '';
      el.habitEmpty.hidden = false;
      return;
    }
    el.habitEmpty.hidden = true;

    var weekKeys = currentWeekKeys();
    var weekdayShort = ['一', '二', '三', '四', '五', '六', '日'];

    list.innerHTML = state.habits.map(function (h) {
      var done = Core.habitProgress(state, h.id, weekKeys);
      var pct = Math.min(100, Math.round((done / h.targetPerWeek) * 100));
      var cells = weekKeys.map(function (key, i) {
        var checked = Core.habitChecksOn(state, key).indexOf(h.id) !== -1;
        var future = key > TODAY;
        var isToday = key === TODAY;
        var d = Core.parseKey(key);
        return '<button type="button" class="day-cell' + (isToday ? ' today' : '') + '"' +
          ' data-habit="' + esc(h.id) + '" data-date="' + key + '"' +
          ' aria-pressed="' + (checked ? 'true' : 'false') + '"' +
          (future ? ' disabled title="还没到这一天"' : '') +
          ' aria-label="' + esc(h.name + ' ' + Core.formatKeyCN(key) + ' ' + Core.formatWeekdayCN(key) + (checked ? ',已打卡' : ',未打卡')) + '">' +
          weekdayShort[i] + '<span class="d">' + d.getDate() + '</span></button>';
      }).join('');

      return '<div class="habit-row">' +
        '<div class="habit-name">' +
          '<strong>' + esc(h.name) + '</strong>' +
          '<span class="meta">目标每周 ' + h.targetPerWeek + ' 天 · 本周完成 ' + done + ' 天</span>' +
          '<div class="habit-progress" role="presentation"><i style="width:' + pct + '%"></i></div>' +
        '</div>' +
        '<div class="habit-week" role="group" aria-label="' + esc(h.name + ' 本周打卡') + '">' + cells + '</div>' +
        '<div class="habit-tools">' +
          '<label class="target-wrap">每周' +
            '<input type="number" min="1" max="7" step="1" value="' + h.targetPerWeek + '"' +
            ' data-habit-target="' + esc(h.id) + '" aria-label="' + esc(h.name + ' 的每周目标次数') + '">' +
            '次</label>' +
          '<button type="button" class="icon-btn" data-habit-delete="' + esc(h.id) + '" aria-label="' + esc('删除习惯 ' + h.name) + '">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function showHabitError(message) {
    el.habitErrors.innerHTML = '';
    var p = document.createElement('p');
    p.textContent = message;
    el.habitErrors.appendChild(p);
    el.habitErrors.dataset.active = 'true';
    el.habitName.focus();
  }

  function clearHabitError() {
    el.habitErrors.dataset.active = 'false';
    el.habitErrors.innerHTML = '';
  }

  function addHabit(name, target) {
    var trimmed = String(name || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) {
      showHabitError('先写一个习惯名称吧。');
      return false;
    }
    if (trimmed.length > Core.HABIT_NAME_MAX) {
      showHabitError('习惯名称请控制在 ' + Core.HABIT_NAME_MAX + ' 个字以内。');
      return false;
    }
    if (state.habits.length >= 40) {
      showHabitError('习惯已经够多了(最多 40 个),先留几个真正在意的吧。');
      return false;
    }
    var duplicated = state.habits.some(function (h) { return h.name === trimmed; });
    if (duplicated) {
      showHabitError('已经有一个叫「' + trimmed + '」的习惯了。');
      return false;
    }
    var t = Number(target);
    if (!(t >= 1 && t <= 7 && Math.floor(t) === t)) t = 3;

    var id = 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    state.habits.push({ id: id, name: trimmed, targetPerWeek: t });
    Core.touch(state);
    persist();
    clearHabitError();
    el.habitName.value = '';
    renderHabits();
    renderReview();
    renderStorageState();
    toast('已添加「' + trimmed + '」');
    return true;
  }

  function onAddHabit(ev) {
    ev.preventDefault();
    addHabit(el.habitName.value, el.habitTarget.value);
  }

  function toggleHabitCheck(habitId, key) {
    if (key > TODAY) return;
    var habit = state.habits.filter(function (h) { return h.id === habitId; })[0];
    if (!habit) return;
    var list = (state.habitChecks[key] || []).slice();
    var index = list.indexOf(habitId);
    if (index === -1) list.push(habitId);
    else list.splice(index, 1);
    if (list.length) state.habitChecks[key] = list;
    else delete state.habitChecks[key];

    Core.touch(state);
    persist();
    renderHabits();
    renderReview();
    renderStorageState();
  }

  function onHabitListClick(ev) {
    var delBtn = ev.target.closest ? ev.target.closest('[data-habit-delete]') : null;
    if (delBtn) {
      deleteHabit(delBtn.getAttribute('data-habit-delete'));
      return;
    }
    var cell = ev.target.closest ? ev.target.closest('[data-habit]') : null;
    if (cell) {
      toggleHabitCheck(cell.getAttribute('data-habit'), cell.getAttribute('data-date'));
    }
  }

  function onHabitTargetChange(ev) {
    var input = ev.target.closest ? ev.target.closest('[data-habit-target]') : null;
    if (!input) return;
    var habitId = input.getAttribute('data-habit-target');
    var habit = state.habits.filter(function (h) { return h.id === habitId; })[0];
    if (!habit) return;
    var value = Number(input.value);
    if (!(value >= 1 && value <= 7 && Math.floor(value) === value)) {
      input.value = habit.targetPerWeek;
      toast('每周目标请填 1–7 的整数');
      return;
    }
    if (value === habit.targetPerWeek) return;
    habit.targetPerWeek = value;
    Core.touch(state);
    persist();
    renderHabits();
    renderReview();
    renderStorageState();
    toast('「' + habit.name + '」的每周目标改为 ' + value + ' 天');
  }

  async function deleteHabit(habitId) {
    var habit = state.habits.filter(function (h) { return h.id === habitId; })[0];
    if (!habit) return;
    var answer = await confirmBox({
      title: '删除这个习惯?',
      body: '<p>将删除习惯「<strong>' + esc(habit.name) + '</strong>」以及它在各天的打卡记录。</p><p>其他习惯和当天的身体记录不受影响。</p>',
      confirmLabel: '删除习惯',
      cancelLabel: '保留',
      danger: true
    });
    if (!answer) return;
    state.habits = state.habits.filter(function (h) { return h.id !== habitId; });
    Object.keys(state.habitChecks).forEach(function (key) {
      var list = state.habitChecks[key].filter(function (id) { return id !== habitId; });
      if (list.length) state.habitChecks[key] = list;
      else delete state.habitChecks[key];
    });
    Core.touch(state);
    persist();
    renderHabits();
    renderReview();
    renderStorageState();
    toast('已删除习惯「' + habit.name + '」');
  }

  /* ---------------- 趋势 ---------------- */

  function renderTrend() {
    var keys = Core.rangeKeys(TODAY, trendRange);
    var sum = Core.summarizeWeights(state.entries, keys);
    renderChart(sum, keys);
    renderTrendStats(sum);
    renderTrendSummary(sum, keys);
    el.range7.setAttribute('aria-pressed', trendRange === 7 ? 'true' : 'false');
    el.range30.setAttribute('aria-pressed', trendRange === 30 ? 'true' : 'false');
  }

  function renderChart(sum, keys) {
    var box = el.trendChart;
    if (!sum.points.length) {
      box.innerHTML = '<div class="chart-empty"><div>' +
        '<p><strong>这段时间还没有体重记录。</strong></p>' +
        '<p class="small muted" style="margin-top:6px">体重是完全可选的。记睡眠、运动或心情,也足够了解自己的节奏。</p>' +
        '</div></div>';
      return;
    }

    var W = 660;
    var H = 260;
    var padL = 52;
    var padR = 24;
    var padT = 28;
    var padB = 40;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var values = sum.points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    if (hi - lo < 1.5) {
      var mid = (hi + lo) / 2;
      lo = mid - 0.75;
      hi = mid + 0.75;
    }
    lo = Math.floor((lo - 0.3) * 10) / 10;
    hi = Math.ceil((hi + 0.3) * 10) / 10;

    var span = Math.max(1, keys.length - 1);
    function xFor(key) {
      var idx = Core.diffDays(key, keys[0]);
      return padL + (idx / span) * plotW;
    }
    function yFor(v) {
      return padT + (1 - (v - lo) / (hi - lo)) * plotH;
    }

    var ticks = [
      { v: hi, y: yFor(hi) },
      { v: Core.round1((hi + lo) / 2), y: yFor((hi + lo) / 2) },
      { v: lo, y: yFor(lo) }
    ];

    var grid = ticks.map(function (t) {
      return '<line x1="' + padL + '" y1="' + t.y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + t.y.toFixed(1) + '" stroke="#ece5d6" stroke-width="1"></line>' +
        '<text x="' + (padL - 10) + '" y="' + (t.y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#7d8b81">' + fmtNum(t.v) + '</text>';
    }).join('');

    var linePoints = sum.points.map(function (p) {
      return xFor(p.key).toFixed(1) + ',' + yFor(p.value).toFixed(1);
    });
    var polyline = linePoints.length > 1
      ? '<polyline points="' + linePoints.join(' ') + '" fill="none" stroke="#2f6b4f" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>'
      : '';
    var area = linePoints.length > 1
      ? '<polygon points="' + linePoints.join(' ') + ',' + xFor(sum.points[sum.points.length - 1].key).toFixed(1) + ',' + (H - padB) + ',' + xFor(sum.points[0].key).toFixed(1) + ',' + (H - padB) + '" fill="rgba(47,107,79,0.07)"></polygon>'
      : '';

    var dots = sum.points.map(function (p, i) {
      var last = i === sum.points.length - 1;
      return '<circle cx="' + xFor(p.key).toFixed(1) + '" cy="' + yFor(p.value).toFixed(1) + '" r="' + (last ? 5.2 : 4.2) + '" fill="' + (last ? '#1e4a36' : '#2f6b4f') + '" stroke="#fff" stroke-width="1.5">' +
        '<title>' + esc(Core.formatKeyWithWeek(p.key) + ' · ' + fmtNum(p.value) + ' kg') + '</title></circle>';
    }).join('');

    var lastPoint = sum.points[sum.points.length - 1];
    var lastLabel = '<text x="' + (xFor(lastPoint.key) - 2).toFixed(1) + '" y="' + (yFor(lastPoint.value) - 12).toFixed(1) + '" text-anchor="end" font-size="12" font-weight="600" fill="#1e4a36">' + fmtNum(lastPoint.value) + ' kg</text>';

    var tickIdx = keys.length === 7 ? [0, 1, 2, 3, 4, 5, 6] : [0, 7, 14, 21, keys.length - 1];
    var xLabels = tickIdx.filter(function (i) { return i >= 0 && i < keys.length; }).map(function (i) {
      var key = keys[i];
      var x = xFor(key);
      var anchor = i === 0 ? 'start' : (i === keys.length - 1 ? 'end' : 'middle');
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 14) + '" text-anchor="' + anchor + '" font-size="11" fill="#7d8b81">' + Core.formatShortCN(key) + '</text>';
    }).join('');

    var ariaLabel = '体重折线图,最近 ' + keys.length + ' 天共记录 ' + sum.count + ' 次,范围 ' + fmtNum(sum.min) + ' 到 ' + fmtNum(sum.max) + ' 千克';

    box.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ariaLabel) + '" preserveAspectRatio="xMidYMid meet">' +
      '<text x="' + (padL - 10) + '" y="16" text-anchor="end" font-size="11" fill="#7d8b81">kg</text>' +
      grid + area + polyline + dots + lastLabel + xLabels +
      '</svg>';
  }

  function renderTrendStats(sum) {
    var items = [
      { k: '记录次数', v: sum.count ? String(sum.count) : '—', u: '次' },
      { k: '平均', v: sum.avg !== null ? fmtNum(sum.avg) : '—', u: 'kg' },
      { k: '最低', v: sum.min !== null ? fmtNum(sum.min) : '—', u: 'kg' },
      { k: '最高', v: sum.max !== null ? fmtNum(sum.max) : '—', u: 'kg' }
    ];
    el.trendStats.innerHTML = items.map(function (it) {
      return '<div class="stat"><div class="k">' + it.k + '</div><div class="v">' + it.v + '<span class="u">' + it.u + '</span></div></div>';
    }).join('');
  }

  function renderTrendSummary(sum, keys) {
    var days = keys.length;
    var text = '';
    if (!sum.count) {
      text = '最近 ' + days + ' 天没有体重记录。不记录体重,也可以继续用其他功能。';
    } else if (sum.count === 1) {
      text = '最近 ' + days + ' 天记录了 1 次体重:' + fmtNum(sum.last.value) + ' kg(' + Core.formatKeyCN(sum.last.key) + ')。只有一次记录,先不用解读趋势。';
    } else {
      var changeText = sum.change === 0 ? '持平' : (sum.change > 0 ? '+' : '−') + Math.abs(sum.change) + ' kg';
      text = '最近 ' + days + ' 天记录了 ' + sum.count + ' 次体重,平均 ' + fmtNum(sum.avg) + ' kg,最低 ' + fmtNum(sum.min) + ' kg,最高 ' + fmtNum(sum.max) + ' kg。' +
        '最近一次是 ' + fmtNum(sum.last.value) + ' kg(' + Core.formatKeyCN(sum.last.key) + '),与最早一次相比' + changeText + '。';
      if (sum.count < 3) text += '记录还不多,慢慢来。';
    }
    var waist = Core.latestField(state.entries, 'waist', keys);
    if (waist) {
      text += '最近一次腰围 ' + fmtNum(waist.value) + ' cm(' + Core.formatKeyCN(waist.key) + ')。';
    }
    el.trendSummary.textContent = text;
  }

  /* ---------------- 每周复盘 ---------------- */

  function renderReview() {
    var weekKeys = currentWeekKeys();
    var rev = Core.weeklyReview(state, weekKeys);
    el.reviewIntro.textContent = '本周从 ' + Core.formatKeyCN(weekKeys[0]) + ' 到 ' + Core.formatKeyCN(weekKeys[6]) +
      (weekKeys[6] > TODAY ? ',还没过完' : '') + '。';

    var lines = [];
    if (!rev.daysWithAny && !rev.habitDone) {
      lines.push('本周还没有记录。空着也正常,想开始的时候记一天就够。');
    } else {
      lines.push('本周记录了 ' + rev.daysWithAny + ' 天,其中 ' + rev.weightDays + ' 天记了体重。');
      if (state.habits.length) {
        var pct = rev.habitTarget ? Math.round((rev.habitDone / rev.habitTarget) * 100) : 0;
        lines.push('习惯打卡完成 ' + rev.habitDone + ' 次,你给自己定的本周目标合计 ' + rev.habitTarget + ' 次(完成约 ' + pct + '%)。');
      } else {
        lines.push('本周还没有设置习惯。');
      }
      if (rev.activityDays) {
        lines.push('有记录的 ' + rev.activityDays + ' 天里,运动合计 ' + rev.activitySum + ' 分钟。');
      }
      if (rev.sleepDays) {
        lines.push('有睡眠记录的 ' + rev.sleepDays + ' 天,平均 ' + fmtNum(rev.sleepAvg) + ' 小时。');
      }
      if (rev.waistLatest) {
        lines.push('本周最近一次腰围 ' + fmtNum(rev.waistLatest.value) + ' cm。');
      }
    }

    el.reviewLines.innerHTML = lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');

    if (!rev.daysWithAny && !rev.habitDone) {
      el.reviewNote.textContent = '这里只做记录,不打分。等你想记录的时候,再来就好。';
    } else if (rev.habitDone >= rev.habitTarget && rev.habitTarget > 0) {
      el.reviewNote.textContent = '这周你给自己定的目标达成了。不用加码,保持住就已经很好。';
    } else {
      el.reviewNote.textContent = '复盘只看习惯有没有落地,不评价外貌。觉得累了,下周把目标调低一点也完全可以。';
    }
  }

  /* ---------------- 存储状态 ---------------- */

  function renderStorageState() {
    var available = repo.available();
    var sizeKb = (JSON.stringify(state).length / 1024).toFixed(1);
    var html = '';
    html += '<span>存储位置:本机浏览器 localStorage(只在这台设备上)</span>';
    html += '<span>当前模式:<strong>' + (mode === 'demo' ? '演示数据' : '我的记录') + '</strong></span>';
    html += available
      ? '<span class="ok">本地保存可用</span>'
      : '<span class="bad">当前浏览器不允许本地保存,关闭页面后记录会丢失</span>';
    html += '<span>记录占用约 ' + sizeKb + ' KB</span>';
    html += '<span>最近保存 ' + fmtTime(state.meta && state.meta.updatedAt) + '</span>';

    if (loadWarning) {
      html += '<span class="bad">读取旧数据时遇到问题:' + esc(loadWarning) + '</span>';
      if (rawBackup) {
        html += '<button type="button" class="linkish" data-raw-export="1">下载读取到的原始数据</button>';
      }
    }
    el.storageState.innerHTML = html;
  }

  /* ---------------- 弹窗与提示 ---------------- */

  function confirmBox(opts) {
    return openDialog({
      title: opts.title,
      body: opts.body,
      actions: [
        { label: opts.cancelLabel || '取消', value: false },
        { label: opts.confirmLabel || '确认', value: true, danger: !!opts.danger, primary: !opts.danger }
      ]
    });
  }

  function openDialog(opts) {
    return new Promise(function (resolve) {
      if (el.confirmDialog.open) el.confirmDialog.close();
      el.dialogTitle.textContent = opts.title;
      el.dialogContent.innerHTML = opts.body;
      el.dialogActions.innerHTML = '';

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (el.confirmDialog.open) el.confirmDialog.close();
        resolve(value);
      }

      opts.actions.forEach(function (action) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (action.danger ? 'btn-danger' : action.primary ? 'btn-primary' : 'btn-ghost');
        btn.textContent = action.label;
        btn.addEventListener('click', function () { finish(action.value); });
        el.dialogActions.appendChild(btn);
      });

      el.confirmDialog.addEventListener('close', function onClose() {
        el.confirmDialog.removeEventListener('close', onClose);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });

      if (typeof el.confirmDialog.showModal === 'function') {
        el.confirmDialog.showModal();
      } else {
        el.confirmDialog.setAttribute('open', 'open');
      }

      var first = el.dialogActions.querySelector('button');
      if (first) first.focus();
    });
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
    }, 3400);
  }

  /* ---------------- 导出 / 导入 / 清空 ---------------- */

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function onExport() {
    var payload = Core.buildExportPayload(state);
    var json = JSON.stringify(payload, null, 2);
    var name = 'haohao-care-' + (mode === 'demo' ? 'demo-' : '') + TODAY + '.json';
    try {
      download(name, json, 'application/json;charset=utf-8');
      toast('已导出 ' + Core.countDays(state) + ' 天记录,文件已开始下载');
    } catch (err) {
      toast('导出失败,当前浏览器可能不支持下载');
    }
  }

  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('读取失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  async function handleImportFile(file) {
    if (!file) return;
    var text;
    try {
      text = await readFileText(file);
    } catch (err) {
      await openDialog({
        title: '读不了这个文件',
        body: '<p>浏览器没能读取「' + esc(file.name) + '」,可以换一个文件再试。</p>',
        actions: [{ label: '知道了', value: true, primary: true }]
      });
      return;
    }

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      await openDialog({
        title: '这个文件不是有效的 JSON',
        body: '<p>「' + esc(file.name) + '」无法解析。请选择由本页“导出 JSON”生成的文件,不要手动改动格式。</p>',
        actions: [{ label: '知道了', value: true, primary: true }]
      });
      return;
    }

    var res = Core.sanitizeStore(parsed, TODAY);
    if (!res.ok) {
      await openDialog({
        title: '这份备份没有通过检查',
        body: '<p>为了避免把不完整的数据写进来,这次没有导入。发现的问题:</p><ul>' +
          res.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') +
          '</ul>',
        actions: [{ label: '知道了', value: true, primary: true }]
      });
      return;
    }

    var imported = res.store;
    var days = Core.countDays(imported);
    var demoNotice = '';
    if (parsed.demo && mode !== 'demo') {
      demoNotice = '<p style="margin-top:10px"><strong>提醒:</strong>这是一份演示数据的导出文件,导入后会成为“我的记录”,请注意区分。</p>';
    }

    var choice = await openDialog({
      title: '导入这份备份?',
      body: '<p>文件里有 <strong>' + days + ' 天记录、' + imported.habits.length + ' 个习惯</strong>。</p>' +
        '<p style="margin-top:8px">合并:保留现有记录,同一天以文件里的字段为准,文件里没写的字段保留原值。<br>替换:清掉当前模式的全部数据,只保留文件内容。</p>' +
        demoNotice,
      actions: [
        { label: '取消', value: 'cancel' },
        { label: '合并到现有记录', value: 'merge', primary: true },
        { label: '替换全部记录', value: 'replace', danger: true }
      ]
    });

    if (choice !== 'merge' && choice !== 'replace') return;

    if (choice === 'merge') {
      state = Core.mergeStores(state, imported);
    } else {
      state = imported;
    }
    state.demo = mode === 'demo';
    Core.touch(state);
    persist();
    renderAll();
    populateForm(editingKey);
    toast(choice === 'merge' ? '已合并导入 ' + days + ' 天记录' : '已替换为导入的 ' + days + ' 天记录');
  }

  async function onClear() {
    var days = Core.countDays(state);
    var habits = state.habits.length;
    if (days === 0 && habits === 0) {
      toast('当前没有可清空的数据');
      return;
    }
    var label = mode === 'demo' ? '演示数据' : '我的记录';
    var answer = await confirmBox({
      title: '确定清空' + label + '?',
      body: '<p>将删除 <strong>' + days + ' 天记录和 ' + habits + ' 个习惯</strong>,包括对应的打卡。</p>' +
        '<p>此操作无法撤销。建议先点“导出 JSON”留一份备份。</p>' +
        (mode === 'demo' ? '<p>这只影响演示数据,你的真实记录不会被碰到。</p>' : ''),
      confirmLabel: '确认清空',
      cancelLabel: '先不清理',
      danger: true
    });
    if (!answer) return;

    var res = repo.clear();
    if (!res.ok) toast(res.error || '清空失败');
    state = Core.createEmptyStore();
    loadWarning = null;
    rawBackup = null;
    renderAll();
    populateForm(TODAY);
    toast('已清空' + label);
  }

  /* ---------------- 模式切换 ---------------- */

  function switchMode(next) {
    mode = next;
    repo = Core.makeRepository(storage, mode);
    var res = repo.load();
    loadWarning = res.error;
    rawBackup = res.raw;

    if (res.store) {
      state = res.store;
    } else if (mode === 'demo') {
      state = Core.buildDemoStore(TODAY);
      repo.save(state);
    } else {
      state = Core.createEmptyStore();
    }

    editingKey = TODAY;
    renderAll();
    populateForm(editingKey);
    if (mode === 'demo') {
      toast('已打开演示数据:以下是示例,不会写入你的真实记录');
    } else {
      toast('已回到你的记录');
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    el.btnAnotherThing.addEventListener('click', function () {
      thingOffset += 1;
      renderSmallThing();
    });

    el.entryDate.addEventListener('change', function () {
      var value = el.entryDate.value;
      if (!Core.isValidKey(value)) return;
      populateForm(value);
    });

    el.entryForm.addEventListener('submit', onSubmitEntry);
    el.btnResetForm.addEventListener('click', resetInputs);
    el.btnDeleteEntry.addEventListener('click', onDeleteEntry);

    el.habitForm.addEventListener('submit', onAddHabit);
    el.habitList.addEventListener('click', onHabitListClick);
    el.habitList.addEventListener('change', onHabitTargetChange);

    el.habitSuggestions.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-suggest]') : null;
      if (!btn) return;
      addHabit(btn.getAttribute('data-suggest'), el.habitTarget.value);
    });

    el.range7.addEventListener('click', function () {
      trendRange = 7;
      renderTrend();
    });
    el.range30.addEventListener('click', function () {
      trendRange = 30;
      renderTrend();
    });

    el.btnExport.addEventListener('click', onExport);

    el.importFile.addEventListener('change', function () {
      var file = el.importFile.files && el.importFile.files[0];
      el.importFile.value = '';
      if (file) handleImportFile(file);
    });

    el.btnClear.addEventListener('click', onClear);

    el.btnDemoOn.addEventListener('click', function () {
      if (mode === 'demo') return;
      switchMode('demo');
    });

    el.btnDemoOff.addEventListener('click', function () {
      if (mode === 'real') return;
      switchMode('real');
    });

    el.storageState.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-raw-export]') : null;
      if (!btn) return;
      var text = rawBackup || '';
      if (!text) {
        toast('没有可下载的原始数据');
        return;
      }
      try {
        download('haohao-care-raw-' + TODAY + '.json', text, 'application/json;charset=utf-8');
        toast('已下载读取到的原始数据,请不要手动改动后再导入');
      } catch (err) {
        toast('下载失败,当前浏览器可能不支持');
      }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.confirmDialog.open) {
        el.confirmDialog.close();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
