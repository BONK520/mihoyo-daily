(function () {
  'use strict';

  var STORAGE_KEY = 'mihoyo-daily:v1';
  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  // 亚服为 UTC+8，每天 04:00 重置。UTC+8 的 04:00 等于 UTC+4 的 00:00，
  // 所以把时间加 4 小时后按「天」切分，就能得到以 04:00 为界的一天。
  var RESET_SHIFT = 4 * HOUR;
  var SERVER_OFFSET = 8 * HOUR;
  // 以 04:00 为界切分后，第 4 天（1970-01-05）是星期一，用它当每周起点。
  var MONDAY_DAY_INDEX = 4;

  var GAMES = [
    {
      id: 'genshin', name: '原神', glyph: '原',
      stamina: '原粹树脂', staminaShort: '树脂',
      max: 200, rate: 8, spend: [20, 30, 40, 60]
    },
    {
      id: 'hsr', name: '崩坏：星穹铁道', glyph: '星',
      stamina: '开拓力', staminaShort: '开拓力',
      max: 300, rate: 6, spend: [10, 30, 40, 60]
    },
    {
      id: 'zzz', name: '绝区零', glyph: '绝',
      stamina: '电量', staminaShort: '电量',
      max: 240, rate: 6, spend: [20, 40, 60]
    }
  ];
  var GAME_BY_ID = {};
  GAMES.forEach(function (g) { GAME_BY_ID[g.id] = g; });

  // [名称, 需要完成的次数]
  var DEFAULT_LISTS = {
    genshin: {
      daily: [
        ['每日委托', 4],
        ['找凯瑟琳领取每日委托奖励', 1],
        ['消耗原粹树脂（秘境/地脉/首领）', 1],
        ['探索派遣：收取并重新派遣', 1],
        ['尘歌壶：领取洞天宝钱与好感经验', 1],
        ['HoYoLAB 每日签到', 1]
      ],
      weekly: [
        ['周常首领（树脂减半 ×3）', 3],
        ['纪行每周任务', 1],
        ['尘歌壶：壶灵商店兑换', 1],
        ['参量质变仪', 1]
      ]
    },
    hsr: {
      daily: [
        ['每日实训（活跃度 500）', 1],
        ['消耗开拓力', 1],
        ['委托：收取并重新派遣', 1],
        ['HoYoLAB 每日签到', 1]
      ],
      weekly: [
        ['历战余响（周本 ×3）', 3],
        ['模拟宇宙/差分宇宙 每周积分', 1],
        ['无名勋礼 每周任务', 1]
      ]
    },
    zzz: {
      daily: [
        ['今日活跃度 400', 1],
        ['消耗电量', 1],
        ['录像店经营', 1],
        ['报刊亭刮刮卡', 1],
        ['咖啡店喝咖啡', 1],
        ['HoYoLAB 每日签到', 1]
      ],
      weekly: [
        ['恶名狩猎（周本 ×3）', 3],
        ['丽都周纪 积分奖励', 1],
        ['零号空洞/迷失之地 每周奖励', 1],
        ['丽都城募 每周任务', 1]
      ]
    }
  };

  var LIST_META = {
    daily: { title: '每日', cd: 'daily', rule: '每天 04:00 重置' },
    weekly: { title: '每周', cd: 'weekly', rule: '每周一 04:00 重置' }
  };

  var MAX_NAME = 40;
  var MAX_TARGET = 99;

  // ---------- 时间与重置 ----------

  function dayIndex(t) { return Math.floor((t + RESET_SHIFT) / DAY); }
  function weekIndex(t) { return Math.floor((dayIndex(t) - MONDAY_DAY_INDEX) / 7); }
  function nextDailyReset(t) { return (dayIndex(t) + 1) * DAY - RESET_SHIFT; }
  function nextWeeklyReset(t) {
    return ((weekIndex(t) + 1) * 7 + MONDAY_DAY_INDEX) * DAY - RESET_SHIFT;
  }

  // ---------- 资料 ----------

  var storageOk = true;
  var state = null;
  // 只存在内存里的界面状态
  var editing = {};

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function makeItems(defs) {
    return defs.map(function (d) {
      return { id: newId(), name: d[0], target: d[1], count: 0 };
    });
  }

  function defaultGameState(gid, now) {
    var g = GAME_BY_ID[gid];
    return {
      daily: makeItems(DEFAULT_LISTS[gid].daily),
      weekly: makeItems(DEFAULT_LISTS[gid].weekly),
      dayKey: dayIndex(now),
      weekKey: weekIndex(now),
      stamina: { value: null, at: 0, max: g.max, rate: g.rate }
    };
  }

  function clampInt(n, lo, hi) {
    n = Math.floor(Number(n));
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function sanitizeItems(arr, fallback) {
    if (!Array.isArray(arr)) return fallback;
    var out = [];
    arr.forEach(function (it) {
      if (!it || typeof it.name !== 'string') return;
      var target = clampInt(it.target, 1, MAX_TARGET);
      out.push({
        id: typeof it.id === 'string' && it.id ? it.id : newId(),
        name: it.name.slice(0, MAX_NAME),
        target: target,
        count: clampInt(it.count, 0, target)
      });
    });
    return out;
  }

  function sanitizeGame(gid, raw, now) {
    var def = defaultGameState(gid, now);
    if (!raw || typeof raw !== 'object') return def;
    var st = raw.stamina && typeof raw.stamina === 'object' ? raw.stamina : {};
    var max = Number(st.max);
    var rate = Number(st.rate);
    var value = st.value == null ? null : Number(st.value);
    return {
      daily: sanitizeItems(raw.daily, def.daily),
      weekly: sanitizeItems(raw.weekly, def.weekly),
      dayKey: typeof raw.dayKey === 'number' ? raw.dayKey : def.dayKey,
      weekKey: typeof raw.weekKey === 'number' ? raw.weekKey : def.weekKey,
      stamina: {
        value: value != null && isFinite(value) ? clampInt(value, 0, 9999) : null,
        at: isFinite(Number(st.at)) ? Number(st.at) : 0,
        max: isFinite(max) && max >= 1 ? clampInt(max, 1, 9999) : def.stamina.max,
        rate: isFinite(rate) && rate >= 0.1 ? Math.min(rate, 1440) : def.stamina.rate
      }
    };
  }

  function load() {
    var now = Date.now();
    var raw = null;
    try {
      var text = localStorage.getItem(STORAGE_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch (e) {
      raw = null;
    }
    var games = {};
    GAMES.forEach(function (g) {
      games[g.id] = sanitizeGame(g.id, raw && raw.games ? raw.games[g.id] : null, now);
    });
    return { version: 1, games: games };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    updateBanner();
  }

  // 返回 true 表示有清单被清空
  function ensureResets(now) {
    var changed = false;
    var d = dayIndex(now);
    var w = weekIndex(now);
    GAMES.forEach(function (g) {
      var gs = state.games[g.id];
      if (gs.dayKey !== d) {
        gs.daily.forEach(function (it) { it.count = 0; });
        gs.dayKey = d;
        changed = true;
      }
      if (gs.weekKey !== w) {
        gs.weekly.forEach(function (it) { it.count = 0; });
        gs.weekKey = w;
        changed = true;
      }
    });
    return changed;
  }

  // ---------- 体力 ----------

  function staminaInfo(gid, now) {
    var st = state.games[gid].stamina;
    var info = { set: false, max: st.max, rate: st.rate };
    if (st.value == null) return info;
    var rateMs = st.rate * MIN;
    info.set = true;
    if (st.value >= st.max) {
      info.cur = st.value;
      info.full = true;
      info.fullAt = st.at;
      return info;
    }
    var elapsed = Math.max(0, now - st.at);
    info.fullAt = st.at + (st.max - st.value) * rateMs;
    info.cur = Math.min(st.max, st.value + Math.floor(elapsed / rateMs));
    info.full = info.cur >= st.max;
    info.left = Math.max(0, info.fullAt - now);
    info.next = info.full ? 0 : rateMs - (elapsed % rateMs);
    return info;
  }

  function setStamina(gid, value) {
    var st = state.games[gid].stamina;
    st.value = clampInt(value, 0, 9999);
    st.at = Date.now();
  }

  function spendStamina(gid, n) {
    var st = state.games[gid].stamina;
    var now = Date.now();
    var info = staminaInfo(gid, now);
    if (!info.set) return 'unset';
    if (info.cur < n) return 'short';
    var rateMs = st.rate * MIN;
    if (info.full) {
      // 满了以后游戏内不再计时，花掉后从现在开始重新计
      st.at = now;
    } else {
      // 保留「下一点」已经累积的进度
      st.at = st.at + Math.floor((now - st.at) / rateMs) * rateMs;
    }
    st.value = info.cur - n;
    return 'ok';
  }

  // ---------- 格式化 ----------

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtCountdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400);
    s -= d * 86400;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var hms = pad(h) + ':' + pad(m) + ':' + pad(sec);
    return d > 0 ? d + '天 ' + hms : hms;
  }

  function fmtDuration(ms) {
    var total = Math.ceil(ms / MIN);
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (h === 0) return m + ' 分钟';
    return h + ' 小时 ' + pad(m) + ' 分';
  }

  function fmtMinSec(ms) {
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }

  function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // 用设备本地时间显示「今天 18:24」这类时间点
  function fmtWhen(ts) {
    var d = new Date(ts);
    var diff = Math.round((startOfLocalDay(d) - startOfLocalDay(new Date())) / DAY);
    var names = { '-2': '前天', '-1': '昨天', '0': '今天', '1': '明天', '2': '后天' };
    var day = names[String(diff)] || (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtServerClock(now) {
    var d = new Date(now + SERVER_OFFSET);
    return '亚服 ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() +
      ' 周' + '日一二三四五六'.charAt(d.getUTCDay()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- 统计 ----------

  function isDone(it) { return it.count >= it.target; }

  function tally(items) {
    var done = 0;
    items.forEach(function (it) { if (isDone(it)) done++; });
    return { done: done, total: items.length };
  }

  function pct(t) { return t.total ? Math.round((t.done / t.total) * 100) : 0; }

  // ---------- 画面 ----------

  var view = document.getElementById('view');
  var titleEl = document.getElementById('title');
  var clockEl = document.getElementById('clock');
  var bannerEl = document.getElementById('banner');
  var toastEl = document.getElementById('toast');
  var lastRoute = null;

  var CHECK_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

  function currentRoute() {
    var h = (location.hash || '').replace('#', '');
    if (h === 'settings' || GAME_BY_ID[h]) return h;
    return 'home';
  }

  function render() {
    var route = currentRoute();
    document.body.setAttribute('data-game', route);
    titleEl.textContent = route === 'home' ? '米哈游每日清单'
      : route === 'settings' ? '设置' : GAME_BY_ID[route].name;
    document.title = route === 'home' ? '米哈游每日清单' : titleEl.textContent + ' · 米哈游每日清单';
    Array.prototype.forEach.call(document.querySelectorAll('.tabbar a'), function (a) {
      var active = a.getAttribute('data-tab') === route;
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (route === 'home') view.innerHTML = renderHome();
    else if (route === 'settings') view.innerHTML = renderSettings();
    else view.innerHTML = renderGame(route);

    if (route !== lastRoute) {
      window.scrollTo(0, 0);
      lastRoute = route;
    }
    updateLive(Date.now());
  }

  function renderHome() {
    var allDaily = { done: 0, total: 0 };
    var cards = GAMES.map(function (g) {
      var gs = state.games[g.id];
      var d = tally(gs.daily);
      var w = tally(gs.weekly);
      allDaily.done += d.done;
      allDaily.total += d.total;
      var allDone = d.total > 0 && d.done === d.total;
      return '' +
        '<a class="card game-card accent-' + g.id + '" href="#' + g.id + '">' +
          '<div class="game-head">' +
            '<span class="glyph">' + g.glyph + '</span>' +
            '<h2>' + esc(g.name) + '</h2>' +
            '<span class="badge' + (allDone ? ' all-done' : '') + '">' +
              (allDone ? '今日已完成' : '今日 ' + d.done + '/' + d.total) +
            '</span>' +
          '</div>' +
          progRow('每日', d) +
          progRow('每周', w) +
          '<div class="stamina-line">' +
            '<span>' + g.staminaShort + ' <strong data-st="' + g.id + ':curmax"></strong></span>' +
            '<span class="when" data-st="' + g.id + ':summary"></span>' +
          '</div>' +
        '</a>';
    }).join('');

    return '' +
      '<section class="resets">' +
        '<div class="reset-box">' +
          '<div class="label">每日重置</div>' +
          '<div class="big" data-cd="daily"></div>' +
          '<div class="sub">每天 04:00 · UTC+8</div>' +
        '</div>' +
        '<div class="reset-box">' +
          '<div class="label">每周重置</div>' +
          '<div class="big" data-cd="weekly"></div>' +
          '<div class="sub">周一 04:00 · UTC+8</div>' +
        '</div>' +
      '</section>' +
      '<div class="summary">' +
        '<h2>今日进度</h2>' +
        '<p class="sub">三款合计完成 <strong class="num">' + allDaily.done + '/' + allDaily.total + '</strong> 项</p>' +
      '</div>' +
      cards;
  }

  function progRow(label, t) {
    return '' +
      '<div class="prog-row">' +
        '<span class="label">' + label + '</span>' +
        '<div class="bar"><span style="width:' + pct(t) + '%"></span></div>' +
        '<span class="num">' + t.done + '/' + t.total + '</span>' +
      '</div>';
  }

  function renderGame(gid) {
    var g = GAME_BY_ID[gid];
    return renderStamina(g) + renderList(gid, 'daily') + renderList(gid, 'weekly');
  }

  function renderStamina(g) {
    var st = state.games[g.id].stamina;
    var chips = g.spend.map(function (n) {
      return '<button type="button" class="chip" data-act="spend" data-game="' + g.id + '" data-n="' + n + '">−' + n + '</button>';
    }).join('');
    return '' +
      '<section class="card stamina">' +
        '<div class="stamina-top">' +
          '<div>' +
            '<div class="label">' + g.stamina + '</div>' +
            '<div class="stamina-value"><span data-st="' + g.id + ':cur"></span>' +
              '<span class="max">/' + st.max + '</span></div>' +
          '</div>' +
          '<div class="stamina-full">' +
            '<div class="label">回满时间</div>' +
            '<div class="full-at" data-st="' + g.id + ':fullAt"></div>' +
            '<div class="full-left" data-st="' + g.id + ':left"></div>' +
          '</div>' +
        '</div>' +
        '<div class="meter"><span data-st-bar="' + g.id + '"></span></div>' +
        '<form class="stamina-form" data-form="stamina" data-game="' + g.id + '" autocomplete="off">' +
          '<input class="text-input" name="value" type="number" inputmode="numeric" pattern="[0-9]*" ' +
            'min="0" max="9999" placeholder="输入目前' + g.staminaShort + '" aria-label="目前' + g.stamina + '">' +
          '<button class="btn primary" type="submit">更新</button>' +
        '</form>' +
        '<div class="chips-label">刚刚花掉</div>' +
        '<div class="chips">' + chips + '</div>' +
        '<p class="hint"><span data-st="' + g.id + ':next"></span>上限 ' + st.max + '，每 ' + st.rate +
          ' 分钟回复 1 点，可在「设置」修改。以输入的时间开始计算，实际可能早几分钟回满。</p>' +
      '</section>';
  }

  function renderList(gid, listKey) {
    var gs = state.games[gid];
    var items = gs[listKey];
    var meta = LIST_META[listKey];
    var key = gid + ':' + listKey;
    var isEditing = !!editing[key];
    var t = tally(items);
    var body;

    if (!items.length && !isEditing) {
      body = '<p class="empty">清单是空的，按「编辑」新增项目。</p>';
    } else {
      body = '<ul class="list">' + items.map(function (it, i) {
        return isEditing ? renderEditItem(gid, listKey, it, i, items.length) : renderItem(gid, listKey, it);
      }).join('') + '</ul>';
    }

    var editExtras = '';
    if (isEditing) {
      editExtras = '' +
        '<form class="add-form" data-form="add" data-game="' + gid + '" data-list="' + listKey + '" autocomplete="off">' +
          '<input class="text-input" name="name" maxlength="' + MAX_NAME + '" placeholder="新增项目名称" aria-label="新增项目名称">' +
          '<button class="btn primary" type="submit">新增</button>' +
        '</form>' +
        '<div class="edit-foot">' +
          '<button type="button" class="btn ghost small" data-act="clear" data-game="' + gid + '" data-list="' + listKey + '">清空本表勾选</button>' +
        '</div>';
    }

    return '' +
      '<section class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>' + meta.title + '<span class="tally">' + t.done + '/' + t.total + '</span></h2>' +
            '<p class="sub">' + meta.rule + ' · 还剩 <span data-cd="' + meta.cd + '"></span></p>' +
          '</div>' +
          '<button type="button" class="btn small' + (isEditing ? ' on' : ' ghost') + '" data-act="edit" ' +
            'data-game="' + gid + '" data-list="' + listKey + '">' + (isEditing ? '完成' : '编辑') + '</button>' +
        '</div>' +
        body +
        editExtras +
      '</section>';
  }

  function renderItem(gid, listKey, it) {
    var done = isDone(it);
    var cls = 'item' + (done ? ' done' : it.count > 0 ? ' partial' : '');
    var attrs = 'data-game="' + gid + '" data-list="' + listKey + '" data-id="' + esc(it.id) + '"';
    var count = it.target > 1 ? '<span class="count">' + it.count + '/' + it.target + '</span>' : '';
    var minus = it.target > 1 && it.count > 0
      ? '<button type="button" class="minus" data-act="dec" ' + attrs + ' aria-label="减一次">−</button>'
      : '';
    return '' +
      '<li class="' + cls + '">' +
        '<button type="button" class="item-main" data-act="tap" ' + attrs + ' aria-pressed="' + done + '">' +
          '<span class="check">' + CHECK_SVG + '</span>' +
          '<span class="name">' + esc(it.name) + '</span>' +
          count +
        '</button>' +
        minus +
      '</li>';
  }

  function renderEditItem(gid, listKey, it, i, len) {
    var attrs = 'data-game="' + gid + '" data-list="' + listKey + '" data-id="' + esc(it.id) + '"';
    return '' +
      '<li class="item editing">' +
        '<input class="text-input" data-input="rename" ' + attrs + ' value="' + esc(it.name) + '" ' +
          'maxlength="' + MAX_NAME + '" aria-label="项目名称">' +
        '<div class="edit-tools">' +
          '<span class="stepper">' +
            '<span class="stepper-label">次数</span>' +
            '<button type="button" class="icon-btn" data-act="target-dec" ' + attrs +
              (it.target <= 1 ? ' disabled' : '') + ' aria-label="次数减一">−</button>' +
            '<span class="stepper-val">' + it.target + '</span>' +
            '<button type="button" class="icon-btn" data-act="target-inc" ' + attrs +
              (it.target >= MAX_TARGET ? ' disabled' : '') + ' aria-label="次数加一">+</button>' +
          '</span>' +
          '<span class="edit-actions">' +
            '<button type="button" class="icon-btn" data-act="up" ' + attrs + (i === 0 ? ' disabled' : '') + ' aria-label="上移">↑</button>' +
            '<button type="button" class="icon-btn" data-act="down" ' + attrs + (i === len - 1 ? ' disabled' : '') + ' aria-label="下移">↓</button>' +
            '<button type="button" class="icon-btn danger" data-act="delete" ' + attrs + ' aria-label="删除">' + TRASH_SVG + '</button>' +
          '</span>' +
        '</div>' +
      '</li>';
  }

  function renderSettings() {
    var games = GAMES.map(function (g) {
      var st = state.games[g.id].stamina;
      return '' +
        '<div class="setting-game accent-' + g.id + '">' +
          '<h3><span class="glyph">' + g.glyph + '</span>' + esc(g.name) + ' · ' + g.stamina + '</h3>' +
          '<div class="fields">' +
            '<label class="field"><span>上限</span>' +
              '<input class="text-input" type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="9999" ' +
              'data-setting="max" data-game="' + g.id + '" value="' + st.max + '"></label>' +
            '<label class="field"><span>每点回复（分钟）</span>' +
              '<input class="text-input" type="number" inputmode="decimal" min="0.1" max="1440" step="0.1" ' +
              'data-setting="rate" data-game="' + g.id + '" value="' + st.rate + '"></label>' +
          '</div>' +
          '<button type="button" class="btn ghost small" data-act="reset-stamina" data-game="' + g.id + '">' +
            '恢复预设（' + g.max + ' / 每 ' + g.rate + ' 分钟）</button>' +
        '</div>';
    }).join('');

    var listButtons = GAMES.map(function (g) {
      return '<button type="button" class="btn block" data-act="reset-lists" data-game="' + g.id + '">' +
        esc(g.name) + '：恢复预设清单</button>';
    }).join('');

    return '' +
      '<section class="card">' +
        '<h2>体力设置</h2>' +
        '<p class="sub">预设值是目前版本的数值，如果游戏更新后有改动，可以在这里修改。</p>' +
        '<div style="margin-top:12px">' + games + '</div>' +
      '</section>' +
      '<section class="card">' +
        '<h2>清单</h2>' +
        '<p class="sub">在各游戏页按「编辑」可以新增、改名、删除项目，以及调整次数和顺序。恢复预设会覆盖该游戏目前的清单。</p>' +
        '<div class="btn-col" style="margin-top:12px">' + listButtons + '</div>' +
      '</section>' +
      '<section class="card">' +
        '<h2>重置规则</h2>' +
        '<ul class="rules">' +
          '<li>每日清单：每天 04:00（UTC+8，亚服）自动清空勾选。</li>' +
          '<li>每周清单：每周一 04:00（UTC+8）自动清空勾选。</li>' +
          '<li>回满时间以这台设备的时区显示。</li>' +
        '</ul>' +
      '</section>' +
      '<section class="card">' +
        '<h2>资料</h2>' +
        '<p class="sub">所有资料只保存在这个浏览器的 localStorage，不会上传。清除浏览器资料或换设备后会消失。</p>' +
        '<div class="btn-col" style="margin-top:12px">' +
          '<button type="button" class="btn danger block" data-act="wipe">清除全部资料</button>' +
        '</div>' +
      '</section>';
  }

  // 每秒更新倒计时、时钟和体力，不重画整个画面（避免打断输入）
  function updateLive(now) {
    clockEl.textContent = fmtServerClock(now);
    var dailyText = fmtCountdown(nextDailyReset(now) - now);
    var weeklyText = fmtCountdown(nextWeeklyReset(now) - now);
    Array.prototype.forEach.call(view.querySelectorAll('[data-cd]'), function (el) {
      el.textContent = el.getAttribute('data-cd') === 'daily' ? dailyText : weeklyText;
    });

    var infos = {};
    Array.prototype.forEach.call(view.querySelectorAll('[data-st]'), function (el) {
      var parts = el.getAttribute('data-st').split(':');
      var gid = parts[0];
      var info = infos[gid] || (infos[gid] = staminaInfo(gid, now));
      el.textContent = staminaText(info, parts[1]);
    });
    Array.prototype.forEach.call(view.querySelectorAll('[data-st-bar]'), function (el) {
      var gid = el.getAttribute('data-st-bar');
      var info = infos[gid] || (infos[gid] = staminaInfo(gid, now));
      var p = info.set ? Math.min(100, (info.cur / info.max) * 100) : 0;
      el.style.width = p + '%';
    });
  }

  function staminaText(info, field) {
    switch (field) {
      case 'cur':
        return info.set ? String(info.cur) : '—';
      case 'curmax':
        return (info.set ? info.cur : '—') + '/' + info.max;
      case 'fullAt':
        if (!info.set) return '—';
        return info.full ? '已回满' : fmtWhen(info.fullAt);
      case 'left':
        if (!info.set) return '输入目前数值开始计算';
        if (info.full) return info.fullAt ? fmtWhen(info.fullAt) + ' 已满' : '已满';
        return '还需 ' + fmtDuration(info.left);
      case 'next':
        return info.set && !info.full ? '下一点约 ' + fmtMinSec(info.next) + ' 后。' : '';
      case 'summary':
        if (!info.set) return '未设置';
        return info.full ? '已回满！' : fmtWhen(info.fullAt) + ' 回满';
    }
    return '';
  }

  function tick() {
    var now = Date.now();
    if (ensureResets(now)) {
      save();
      render();
      return;
    }
    updateLive(now);
  }

  function updateBanner() {
    if (storageOk) {
      bannerEl.hidden = true;
    } else {
      bannerEl.hidden = false;
      bannerEl.textContent = '无法保存资料：浏览器可能处于无痕模式或禁用了储存空间，重新整理后变更会消失。';
    }
  }

  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  // ---------- 操作 ----------

  function findItem(gid, listKey, id) {
    var list = state.games[gid] && state.games[gid][listKey];
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list: list, index: i, item: list[i] };
    }
    return null;
  }

  function commit() {
    save();
    render();
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var act = btn.getAttribute('data-act');
    var gid = btn.getAttribute('data-game');
    var listKey = btn.getAttribute('data-list');
    var id = btn.getAttribute('data-id');
    var found = id ? findItem(gid, listKey, id) : null;
    var g = GAME_BY_ID[gid];

    switch (act) {
      case 'tap':
        if (!found) return;
        found.item.count = isDone(found.item) ? 0 : found.item.count + 1;
        commit();
        break;

      case 'dec':
        if (!found) return;
        found.item.count = Math.max(0, found.item.count - 1);
        commit();
        break;

      case 'edit':
        var key = gid + ':' + listKey;
        editing[key] = !editing[key];
        render();
        break;

      case 'target-inc':
      case 'target-dec':
        if (!found) return;
        var it = found.item;
        it.target = clampInt(it.target + (act === 'target-inc' ? 1 : -1), 1, MAX_TARGET);
        it.count = Math.min(it.count, it.target);
        commit();
        break;

      case 'up':
      case 'down':
        if (!found) return;
        var to = found.index + (act === 'up' ? -1 : 1);
        if (to < 0 || to >= found.list.length) return;
        found.list.splice(to, 0, found.list.splice(found.index, 1)[0]);
        commit();
        break;

      case 'delete':
        if (!found) return;
        if (!confirm('删除「' + found.item.name + '」？')) return;
        found.list.splice(found.index, 1);
        commit();
        break;

      case 'clear':
        state.games[gid][listKey].forEach(function (x) { x.count = 0; });
        commit();
        toast('已清空勾选');
        break;

      case 'spend':
        var n = Number(btn.getAttribute('data-n'));
        var result = spendStamina(gid, n);
        if (result === 'unset') { toast('请先输入目前的' + g.staminaShort); return; }
        if (result === 'short') { toast(g.staminaShort + '不够 ' + n); return; }
        commit();
        toast('已扣除 ' + n + ' ' + g.staminaShort);
        break;

      case 'reset-stamina':
        var st = state.games[gid].stamina;
        st.max = g.max;
        st.rate = g.rate;
        commit();
        toast('已恢复' + g.name + '的预设值');
        break;

      case 'reset-lists':
        if (!confirm('把「' + g.name + '」的每日和每周清单恢复成预设？自己新增或改名的项目会消失。')) return;
        state.games[gid].daily = makeItems(DEFAULT_LISTS[gid].daily);
        state.games[gid].weekly = makeItems(DEFAULT_LISTS[gid].weekly);
        commit();
        toast('已恢复预设清单');
        break;

      case 'wipe':
        if (!confirm('清除全部清单、勾选和体力资料？这个动作无法复原。')) return;
        try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* 忽略 */ }
        editing = {};
        state = load();
        commit();
        toast('已清除全部资料');
        break;
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var type = form.getAttribute('data-form');
    if (!type) return;
    e.preventDefault();
    var gid = form.getAttribute('data-game');
    var g = GAME_BY_ID[gid];

    if (type === 'stamina') {
      var raw = form.elements.value.value.trim();
      var v = Number(raw);
      if (raw === '' || !isFinite(v) || v < 0) {
        toast('请输入目前的' + g.staminaShort + '数字');
        return;
      }
      setStamina(gid, v);
      form.elements.value.blur();
      commit();
      toast('已更新' + g.staminaShort);
    } else if (type === 'add') {
      var listKey = form.getAttribute('data-list');
      var name = form.elements.name.value.trim().slice(0, MAX_NAME);
      if (!name) {
        toast('请输入项目名称');
        return;
      }
      state.games[gid][listKey].push({ id: newId(), name: name, target: 1, count: 0 });
      commit();
      // 重画后把焦点放回新增栏，方便连续新增
      var again = view.querySelector('form[data-form="add"][data-game="' + gid + '"][data-list="' + listKey + '"] input');
      if (again) again.focus();
    }
  });

  // 改名：边打字边保存，不重画（避免键盘收起）
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.getAttribute('data-input') !== 'rename') return;
    var found = findItem(el.getAttribute('data-game'), el.getAttribute('data-list'), el.getAttribute('data-id'));
    if (!found) return;
    found.item.name = el.value.slice(0, MAX_NAME);
    save();
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.getAttribute('data-input') === 'rename') {
      var found = findItem(el.getAttribute('data-game'), el.getAttribute('data-list'), el.getAttribute('data-id'));
      if (found && !found.item.name.trim()) {
        found.item.name = '未命名项目';
        el.value = found.item.name;
        save();
      }
      return;
    }

    var setting = el.getAttribute('data-setting');
    if (!setting) return;
    var gid = el.getAttribute('data-game');
    var st = state.games[gid].stamina;
    var v = Number(el.value);
    if (setting === 'max') {
      if (!isFinite(v) || v < 1 || v > 9999) {
        toast('上限请输入 1–9999');
        el.value = st.max;
        return;
      }
      st.max = clampInt(v, 1, 9999);
    } else if (setting === 'rate') {
      if (!isFinite(v) || v < 0.1 || v > 1440) {
        toast('回复速度请输入 0.1–1440 分钟');
        el.value = st.rate;
        return;
      }
      st.rate = Math.round(v * 100) / 100;
    }
    el.value = st[setting];
    save();
    toast('已保存');
  });

  // 其他分页修改了资料时同步
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    state = load();
    ensureResets(Date.now());
    render();
  });

  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick();
  });

  // ---------- 启动 ----------

  state = load();
  ensureResets(Date.now());
  save();
  render();
  setInterval(tick, 1000);
})();
