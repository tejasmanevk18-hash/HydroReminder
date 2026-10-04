(() => {
  'use strict';

  const STORAGE_KEY = 'hydroreminder.v1';
  const SNOOZE_MS = 10 * 60 * 1000;
  const CATCHUP_MIN = 5;          // fire a reminder up to 5 min late (e.g. tab was throttled)
  const GOAL_OPTIONS = [6, 8, 10, 12];
  const SIZE_OPTIONS = [200, 250, 300, 500];

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtTime = (t) => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  };
  const fmtDate = (ts) => fmtTime(`${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}`);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    kids.forEach((c) => el.append(c));
    return el;
  }

  // ---------- state ----------
  function newToday() {
    return { date: dateKey(), count: 0, activity: [], completed: [], log: [], fired: [], active: [] };
  }

  function defaultState() {
    const times = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'];
    return {
      goal: 8,
      glassMl: 250,
      notificationsOn: true,
      reminders: times.map((time) => ({ id: uid(), time, name: 'Drink Water', enabled: true })),
      snoozes: [],
      today: newToday()
    };
  }

  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const s = JSON.parse(raw);
      const t = Object.assign(newToday(), s.today || {});
      ['activity', 'completed', 'log', 'fired', 'active'].forEach((k) => { if (!Array.isArray(t[k])) t[k] = []; });
      return {
        goal: Number.isInteger(s.goal) && s.goal > 0 ? s.goal : base.goal,
        glassMl: Number(s.glassMl) > 0 ? Number(s.glassMl) : base.glassMl,
        notificationsOn: s.notificationsOn !== false,
        reminders: Array.isArray(s.reminders) ? s.reminders.filter((r) => r && /^\d{2}:\d{2}$/.test(r.time)) : base.reminders,
        snoozes: Array.isArray(s.snoozes) ? s.snoozes : [],
        today: t
      };
    } catch (e) {
      return base;
    }
  }

  let state = loadState();
  let swReg = null;
  let editingId = null;
  let formEnabled = true;

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ }
  }

  // Reset ONLY water progress when the local date changes.
  function ensureToday() {
    if (state.today.date !== dateKey()) {
      state.today = newToday();
      state.snoozes = [];
      save();
      return true;
    }
    return false;
  }

  const findReminder = (id) => state.reminders.find((r) => r.id === id);

  // ---------- water actions ----------
  function addGlass(reminderId = null) {
    ensureToday();
    const t = state.today;
    let counted = false;
    if (t.count < state.goal) { t.count += 1; counted = true; }
    if (reminderId) {
      const r = findReminder(reminderId);
      if (r && !t.completed.includes(reminderId)) {
        t.completed.push(reminderId);
        t.activity.push({ rid: reminderId, time: r.time, name: r.name });
      }
    }
    if (counted || reminderId) t.log.push({ rid: reminderId, counted });
    save();
    return counted;
  }

  function undoGlass() {
    ensureToday();
    const t = state.today;
    const last = t.log.pop();
    if (!last) return false;
    if (last.counted && t.count > 0) t.count -= 1;
    if (last.rid) {
      t.completed = t.completed.filter((id) => id !== last.rid);
      const i = t.activity.map((a) => a.rid).lastIndexOf(last.rid);
      if (i > -1) t.activity.splice(i, 1);
    }
    save();
    return true;
  }

  // ---------- reminders / alarms ----------
  function notify(r) {
    if (!state.notificationsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = {
      body: 'Take a moment and drink a glass of water.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'hydro-' + r.id
    };
    try {
      if (swReg && swReg.showNotification) swReg.showNotification('💧 Time to Drink Water!', opts);
      else new Notification('💧 Time to Drink Water!', opts);
    } catch (e) {
      try { new Notification('💧 Time to Drink Water!', opts); } catch (e2) { /* unsupported */ }
    }
  }

  function fire(id) {
    const r = findReminder(id);
    if (!r) return;
    const t = state.today;
    if (!t.fired.includes(id)) t.fired.push(id);
    if (!t.active.includes(id)) t.active.push(id);
    save();
    notify(r);
    renderActive();
  }

  function snooze(id) {
    state.today.active = state.today.active.filter((x) => x !== id);
    state.snoozes = state.snoozes.filter((s) => s.rid !== id);
    const due = Date.now() + SNOOZE_MS;
    state.snoozes.push({ rid: id, due });
    save();
    renderActive();
    toast(`Snoozed until ${fmtDate(due)}`);
  }

  function dismissDrank(id) {
    state.today.active = state.today.active.filter((x) => x !== id);
    state.snoozes = state.snoozes.filter((s) => s.rid !== id);
    const counted = addGlass(id);
    renderAll();
    toast(counted ? '💧 Glass added' : 'Daily goal already reached');
  }

  function tick() {
    const rolled = ensureToday();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const t = state.today;
    let changed = false;

    state.reminders.forEach((r) => {
      if (!r.enabled || t.fired.includes(r.id) || t.completed.includes(r.id)) return;
      const diff = nowMin - toMinutes(r.time);
      if (diff >= 0 && diff <= CATCHUP_MIN) { fire(r.id); changed = true; }
    });

    const nowMs = Date.now();
    const due = state.snoozes.filter((s) => s.due <= nowMs);
    if (due.length) {
      state.snoozes = state.snoozes.filter((s) => s.due > nowMs);
      due.forEach((s) => {
        const r = findReminder(s.rid);
        if (r && r.enabled && !t.completed.includes(s.rid)) fire(s.rid);
      });
      save();
      changed = true;
    }

    if (rolled) renderAll();
    else if (changed) renderAll();
  }

  // ---------- notifications ----------
  function notifSupported() { return 'Notification' in window; }

  function notifMessage() {
    if (!notifSupported()) return 'This browser does not support notifications. In-app reminders still work while the app is open.';
    if (Notification.permission === 'denied') return 'Browser notifications are blocked. To turn them on, allow notifications for this site in your browser or phone settings. In-app reminders still work.';
    if (Notification.permission === 'granted') return state.notificationsOn ? 'Notifications are on.' : 'Notifications are turned off in this app.';
    return 'Notifications are not enabled yet.';
  }

  async function enableNotifications() {
    if (!notifSupported()) { renderNotif(); toast('Notifications are not supported here.'); return; }
    if (Notification.permission === 'granted') {
      state.notificationsOn = true; save(); renderNotif(); toast('Notifications enabled'); return;
    }
    if (Notification.permission === 'denied') {
      state.notificationsOn = false; save(); renderNotif(); toast('Notifications are blocked in your browser settings.'); return;
    }
    let result = 'default';
    try { result = await Notification.requestPermission(); } catch (e) { /* ignore */ }
    state.notificationsOn = result === 'granted';
    save();
    renderNotif();
    toast(result === 'granted' ? 'Notifications enabled' : 'Notifications were not allowed.');
  }

  // ---------- rendering ----------
  function renderProgress() {
    const t = state.today;
    const pct = Math.min(100, Math.round((t.count / state.goal) * 100));
    $('#countText').textContent = `${t.count} / ${state.goal}`;
    $('#progressFill').style.width = pct + '%';
    $('#progressBar').setAttribute('aria-valuenow', String(pct));
    $('#mlText').textContent = `${t.count * state.glassMl} ml of ${state.goal * state.glassMl} ml`;
    const drink = $('#drinkBtn');
    const full = t.count >= state.goal;
    drink.disabled = full;
    drink.textContent = full ? '🎉 Goal reached' : '+ Drink Water';
    $('#undoBtn').disabled = t.log.length === 0;
  }

  function renderReminders() {
    const list = $('#reminderList');
    list.replaceChildren();
    const sorted = [...state.reminders].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    if (!sorted.length) list.append(h('li', { class: 'empty', text: 'No reminders yet. Add one below.' }));
    sorted.forEach((r) => {
      const sw = h('button', {
        class: 'switch' + (r.enabled ? ' on' : ''), type: 'button', role: 'switch',
        'aria-checked': String(r.enabled), 'aria-label': `Toggle reminder at ${fmtTime(r.time)}`,
        'data-action': 'toggle', onclick: () => toggleReminder(r.id)
      }, h('span', { class: 'knob' }));
      const li = h('li', { class: 'reminder ' + (r.enabled ? 'on' : 'off'), 'data-id': r.id },
        h('div', {},
          h('div', { class: 'r-time', text: `💧 ${fmtTime(r.time)}` }),
          h('div', { class: 'r-name', text: r.name })),
        h('div', { class: 'r-state' }, h('span', { text: r.enabled ? 'ON' : 'OFF' }), sw),
        h('div', { class: 'r-actions' },
          h('button', { class: 'btn secondary mini', type: 'button', 'data-action': 'edit', text: 'Edit', onclick: () => openModal(r.id) }),
          h('button', { class: 'btn danger mini', type: 'button', 'data-action': 'delete', text: 'Delete', onclick: () => deleteReminder(r.id) })));
      list.append(li);
    });
  }

  function renderActivity() {
    const list = $('#activityList');
    list.replaceChildren();
    const items = [...state.today.activity].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    if (!items.length) list.append(h('li', { class: 'empty', text: 'Nothing completed yet today.' }));
    items.forEach((a) => list.append(h('li', {},
      h('span', { class: 'tick', text: '✓' }),
      document.createTextNode(`${fmtTime(a.time)} — ${a.name === 'Drink Water' ? 'Water' : a.name}`))));
  }

  function renderActive() {
    const box = $('#activeReminders');
    box.replaceChildren();
    state.today.active.forEach((id) => {
      const r = findReminder(id);
      if (!r) return;
      box.append(h('div', { class: 'alert', 'data-id': id },
        h('h2', { text: '💧 Time to Drink Water!' }),
        h('p', { text: r.name }),
        h('p', { class: 'when', text: `Scheduled for ${fmtTime(r.time)}` }),
        h('button', { class: 'btn primary', type: 'button', 'data-action': 'drank', text: '💧 I Drank Water', onclick: () => dismissDrank(id) }),
        h('button', { class: 'btn ghost', type: 'button', 'data-action': 'snooze', text: 'Snooze 10 min', onclick: () => snooze(id) })));
    });
  }

  function renderSettings() {
    const goal = $('#goalSelect');
    const goals = GOAL_OPTIONS.includes(state.goal) ? GOAL_OPTIONS : [...GOAL_OPTIONS, state.goal].sort((a, b) => a - b);
    goal.replaceChildren(...goals.map((g) => h('option', { value: String(g), text: `${g} glasses` })));
    goal.value = String(state.goal);

    const size = $('#sizeSelect');
    const sizes = SIZE_OPTIONS.includes(state.glassMl) ? SIZE_OPTIONS : [...SIZE_OPTIONS, state.glassMl].sort((a, b) => a - b);
    size.replaceChildren(...sizes.map((s) => h('option', { value: String(s), text: `${s} ml` })));
    size.value = String(state.glassMl);
  }

  function renderNotif() {
    const granted = notifSupported() && Notification.permission === 'granted';
    const on = granted && state.notificationsOn;
    const sw = $('#notifSwitch');
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
    $('#notifStatus').textContent = notifMessage();
    // Banner with the "Enable Notifications" button, hidden once everything is on
    $('#notifBanner').hidden = on;
    $('#notifMsg').textContent = notifMessage();
    $('#enableNotifBtn').hidden = !notifSupported() || Notification.permission === 'denied';
  }

  function renderAll() {
    $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    renderActive();
    renderProgress();
    renderReminders();
    renderActivity();
    renderSettings();
    renderNotif();
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- reminder CRUD + modal ----------
  function setFormEnabled(v) {
    formEnabled = v;
    const sw = $('#enableSwitch');
    sw.classList.toggle('on', v);
    sw.setAttribute('aria-checked', String(v));
  }

  function isTaken(time, exceptId) {
    return state.reminders.some((r) => r.time === time && r.id !== exceptId);
  }

  function nextFreeTime() {
    let hr = (new Date().getHours() + 1) % 24;
    for (let i = 0; i < 24; i++) {
      const t = `${pad((hr + i) % 24)}:00`;
      if (!isTaken(t)) return t;
    }
    return '09:00';
  }

  function openModal(id = null) {
    editingId = id;
    const r = id ? findReminder(id) : null;
    $('#modalTitle').textContent = r ? 'Edit Reminder' : 'Add Reminder';
    $('#timeInput').value = r ? r.time : nextFreeTime();
    $('#nameInput').value = r ? r.name : '';
    setFormEnabled(r ? r.enabled : true);
    $('#formError').hidden = true;
    $('#modal').hidden = false;
    $('#timeInput').focus();
  }

  function closeModal() {
    $('#modal').hidden = true;
    editingId = null;
  }

  function showFormError(msg) {
    const e = $('#formError');
    e.textContent = msg;
    e.hidden = false;
  }

  function submitForm(ev) {
    ev.preventDefault();
    const time = $('#timeInput').value;
    const name = $('#nameInput').value.trim() || 'Drink Water';
    if (!/^\d{2}:\d{2}$/.test(time)) return showFormError('Please choose a time.');
    if (isTaken(time, editingId)) return showFormError(`You already have a reminder at ${fmtTime(time)}.`);

    if (editingId) {
      const r = findReminder(editingId);
      const timeChanged = r.time !== time;
      Object.assign(r, { time, name, enabled: formEnabled });
      if (timeChanged) {
        // A moved reminder is a fresh reminder for today unless already completed.
        state.today.fired = state.today.fired.filter((x) => x !== r.id);
        state.today.active = state.today.active.filter((x) => x !== r.id);
        state.snoozes = state.snoozes.filter((s) => s.rid !== r.id);
      }
      if (!r.enabled) clearPending(r.id);
    } else {
      state.reminders.push({ id: uid(), time, name, enabled: formEnabled });
    }
    save();
    closeModal();
    renderAll();
    toast('Reminder saved');
    tick();
  }

  function clearPending(id) {
    state.today.active = state.today.active.filter((x) => x !== id);
    state.snoozes = state.snoozes.filter((s) => s.rid !== id);
  }

  function toggleReminder(id) {
    const r = findReminder(id);
    if (!r) return;
    r.enabled = !r.enabled;
    if (!r.enabled) clearPending(id);
    save();
    renderAll();
    if (r.enabled) tick();
  }

  function deleteReminder(id) {
    const r = findReminder(id);
    if (!r || !window.confirm(`Delete the ${fmtTime(r.time)} reminder?`)) return;
    state.reminders = state.reminders.filter((x) => x.id !== id);
    clearPending(id);
    state.today.fired = state.today.fired.filter((x) => x !== id);
    save();
    renderAll();
    toast('Reminder deleted');
  }

  // ---------- events ----------
  function bind() {
    $('#drinkBtn').addEventListener('click', () => {
      if (addGlass()) renderAll(); else toast('Daily goal already reached');
    });
    $('#undoBtn').addEventListener('click', () => { if (undoGlass()) { renderAll(); toast('Last glass removed'); } });
    $('#addBtn').addEventListener('click', () => openModal());
    $('#cancelBtn').addEventListener('click', closeModal);
    $('#reminderForm').addEventListener('submit', submitForm);
    $('#enableSwitch').addEventListener('click', () => setFormEnabled(!formEnabled));
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

    $('#goalSelect').addEventListener('change', (e) => {
      state.goal = parseInt(e.target.value, 10) || 8;
      save(); renderAll();
    });
    $('#sizeSelect').addEventListener('change', (e) => {
      state.glassMl = parseInt(e.target.value, 10) || 250;
      save(); renderAll();
    });
    $('#enableNotifBtn').addEventListener('click', enableNotifications);
    $('#notifSwitch').addEventListener('click', () => {
      const currentlyOn = notifSupported() && Notification.permission === 'granted' && state.notificationsOn;
      if (currentlyOn) { state.notificationsOn = false; save(); renderNotif(); }
      else enableNotifications();
    });
    $('#resetBtn').addEventListener('click', () => {
      if (!window.confirm("Reset today's progress? Your reminders will not be changed.")) return;
      state.today = newToday();
      state.snoozes = [];
      save(); renderAll();
      toast("Today's progress was reset");
    });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    window.addEventListener('focus', tick);
  }

  // ---------- init ----------
  function init() {
    ensureToday();
    bind();
    renderAll();
    tick();
    setInterval(tick, 15000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .then(() => navigator.serviceWorker.ready)
        .then((reg) => { swReg = reg; })
        .catch(() => { /* needs https or localhost; app still works without it */ });
    }
  }

  init();
})();
