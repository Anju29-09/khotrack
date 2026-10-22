/* KhoTrack - web / desktop version.
 *
 * Everything lives in this browser. Nothing is sent anywhere, there is no account and
 * no server: teams and matches are held in localStorage under the same key names the
 * Android app uses ("teams", "matches", "liveMatchDraft"), so the two stay conceptually
 * identical. Two devices therefore never see each other's data, and clearing the
 * browser's site data wipes it exactly like uninstalling the app.
 */

/* ============================================================
   STORAGE
   ============================================================ */

const DB = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) {
      console.warn('unreadable', key, e);
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('Storage is full or blocked - the change was not saved');
      return false;
    }
  },
  remove(key) { try { localStorage.removeItem(key); } catch (e) {} }
};

const Teams = {
  all: () => DB.read('teams', []),
  save: list => DB.write('teams', list),
  byName(name) {
    if (!name) return null;
    return this.all().find(t => (t.teamName || '').toLowerCase() === name.toLowerCase()) || null;
  }
};

const Matches = {
  all: () => DB.read('matches', []),
  save: list => DB.write('matches', list),
  add(m) { const l = this.all(); l.push(m); this.save(l); }
};

/* ============================================================
   SMALL UI HELPERS
   ============================================================ */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Promise-based confirm. Resolves 'yes' | 'no' | 'alt'. */
function ask(title, body, { yes = 'OK', no = 'Cancel', alt = null } = {}) {
  return new Promise(resolve => {
    const dlg = $('#dlgConfirm');
    $('#cfTitle').textContent = title;
    $('#cfBody').textContent = body || '';
    $('#cfYes').textContent = yes;
    $('#cfNo').textContent = no;

    const altBtn = $('#cfAlt');
    altBtn.style.display = alt ? '' : 'none';
    if (alt) altBtn.textContent = alt;

    const done = v => { dlg.close(); cleanup(); resolve(v); };
    const onYes = () => done('yes');
    const onNo = () => done('no');
    const onAlt = () => done('alt');
    const onCancel = () => { cleanup(); resolve('no'); };

    function cleanup() {
      $('#cfYes').removeEventListener('click', onYes);
      $('#cfNo').removeEventListener('click', onNo);
      altBtn.removeEventListener('click', onAlt);
      dlg.removeEventListener('cancel', onCancel);
    }

    $('#cfYes').addEventListener('click', onYes);
    $('#cfNo').addEventListener('click', onNo);
    altBtn.addEventListener('click', onAlt);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

/** Promise-based list of choices. Resolves the chosen value, or null. */
function choose(title, body, options) {
  return new Promise(resolve => {
    const dlg = $('#dlgChoice');
    $('#chTitle').textContent = title;
    $('#chBody').textContent = body || '';

    const box = $('#chActions');
    box.innerHTML = '';

    options.forEach(o => {
      const b = document.createElement('button');
      b.textContent = o.label;
      if (o.cls) b.className = o.cls;
      b.onclick = () => { dlg.close(); resolve(o.value); };
      box.appendChild(b);
    });

    dlg.addEventListener('cancel', () => resolve(null), { once: true });
    dlg.showModal();
  });
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
       + '-' + String(d.getDate()).padStart(2, '0');
}

/** Stored in the same shape the Android app writes, e.g. "23 / 9 / 2026". */
function isoToDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return Number(d) + ' / ' + Number(m) + ' / ' + y;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   NAVIGATION
   ============================================================ */

const history_ = [];
let current = 'home';

function go(name, push = true) {
  if (push && name !== current) history_.push(current);
  current = name;
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#s-' + name).classList.add('active');
  window.scrollTo(0, 0);
  if (SCREEN_ENTER[name]) SCREEN_ENTER[name]();
}

function back() {
  const prev = history_.pop() || 'home';
  go(prev, false);
}

const SCREEN_ENTER = {
  home: renderHome,
  teams: renderTeams,
  sheets: renderSheets
};

document.addEventListener('click', e => {
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) { go(goBtn.dataset.go); return; }
  if (e.target.closest('[data-back]')) back();
});

/* ============================================================
   HOME
   ============================================================ */

function renderHome() {
  const draft = DB.read('liveMatchDraft', null);
  const btn = $('#resumeBtn');

  if (draft && draft.team1 && draft.team2) {
    btn.style.display = '';
    btn.textContent = '⏱ Resume  ' + draft.team1.teamName + ' ' + draft.team1Score
                    + ' - ' + draft.team2Score + ' ' + draft.team2.teamName;
  } else {
    btn.style.display = 'none';
  }
}

$('#resumeBtn').onclick = () => {
  const draft = DB.read('liveMatchDraft', null);
  if (!draft) { toast('No unfinished match'); renderHome(); return; }
  Scoring.resume(draft);
};

$('#startMatchBtn').onclick = async () => {
  const draft = DB.read('liveMatchDraft', null);

  if (draft && draft.team1) {
    const r = await ask('Match in Progress',
      'A match is still being scored. Starting a new one will discard it.',
      { yes: 'Discard & Start New', no: 'Cancel', alt: 'Resume it' });

    if (r === 'no') return;
    if (r === 'alt') { Scoring.resume(draft); return; }
    DB.remove('liveMatchDraft');
  }

  go('select');
  renderSelect();
};

/* ============================================================
   TEAM REGISTRATION
   ============================================================ */

(function buildPlayerInputs() {
  const box = $('#playerInputs');
  for (let i = 1; i <= TeamShare.MAX_PLAYERS; i++) {
    const d = document.createElement('div');
    d.className = 'field';
    d.innerHTML = `<input type="text" id="p${i}" placeholder="Player ${i}">`;
    box.appendChild(d);
  }
})();

/* Enter jumps to the next box so a whole squad can be typed without reaching for the
   mouse; Shift+Enter steps back to fix a typo. The last player hands focus to SAVE TEAM
   rather than saving outright, so a stray extra Enter cannot store a half-filled team. */
(function enterMovesOn() {
  const chain = ['#regTeam', '#regCoach'];
  for (let i = 1; i <= TeamShare.MAX_PLAYERS; i++) chain.push('#p' + i);

  chain.forEach((sel, i) => {
    $(sel).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;

      e.preventDefault();

      const target = e.shiftKey ? chain[i - 1] : chain[i + 1];

      if (target) {
        const el = $(target);
        el.focus();
        el.select();
      } else if (!e.shiftKey) {
        $('#saveTeamBtn').focus();
      }
    });
  });
})();

function regClear() {
  $('#regTeam').value = '';
  $('#regCoach').value = '';
  $$('input[name=regType]').forEach(r => r.checked = false);
  $$('input[name=regCat]').forEach(r => r.checked = false);
  for (let i = 1; i <= TeamShare.MAX_PLAYERS; i++) $('#p' + i).value = '';
}

function regFill(parsed) {
  $('#regTeam').value = parsed.teamName || '';
  $('#regCoach').value = parsed.coachName || '';

  $$('input[name=regType]').forEach(r => r.checked = (r.value === parsed.teamType));
  $$('input[name=regCat]').forEach(r => r.checked = (r.value === parsed.category));

  for (let i = 1; i <= TeamShare.MAX_PLAYERS; i++) {
    $('#p' + i).value = parsed.players[i - 1] || '';
  }

  const missing = [];
  if (!parsed.teamName) missing.push('team name');
  if (!parsed.coachName) missing.push('coach');
  if (!parsed.teamType) missing.push('type');
  if (!parsed.category) missing.push('category');

  toast(missing.length
    ? 'Still missing: ' + missing.join(', ')
    : parsed.players.length + ' players read - check and tap SAVE TEAM', 4000);
}

$('#inviteBtn').onclick = async () => {
  const text = TeamShare.buildTemplate();

  if (navigator.share) {
    try { await navigator.share({ title: 'Kho Kho team registration', text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('Blank form copied - paste it into WhatsApp', 4000);
  } catch (e) {
    // clipboard blocked: show it so it can be copied by hand
    $('#pasteText').value = text;
    $('#dlgPaste').showModal();
  }
};

$('#pasteBtn').onclick = async () => {
  let clip = '';
  try { clip = await navigator.clipboard.readText(); } catch (e) { /* needs permission */ }

  const parsed = TeamShare.parse(clip);
  if (parsed) { regFill(parsed); return; }

  $('#pasteText').value = clip || '';
  $('#dlgPaste').showModal();
};

$('#pasteCancel').onclick = () => $('#dlgPaste').close();

$('#pasteOk').onclick = () => {
  const parsed = TeamShare.parse($('#pasteText').value);
  if (!parsed) { toast('Could not read a team from that message'); return; }
  $('#dlgPaste').close();
  regFill(parsed);
};

$('#saveTeamBtn').onclick = () => {
  const name = $('#regTeam').value.trim();
  const coach = $('#regCoach').value.trim();

  const players = [];
  for (let i = 1; i <= TeamShare.MAX_PLAYERS; i++) {
    const v = $('#p' + i).value.trim();
    if (v) players.push(v);
  }

  if (!name || !coach) { toast('Enter team & coach name'); return; }

  if (players.length < 9) {
    toast('Enter at least 9 players (' + players.length + ' entered)', 3500);
    return;
  }

  if (Teams.all().some(t => (t.teamName || '').toLowerCase() === name.toLowerCase())) {
    toast('A team named "' + name + '" already exists', 3500);
    return;
  }

  const type = $('input[name=regType]:checked');
  if (!type) { toast('Select team type'); return; }

  const cat = $('input[name=regCat]:checked');
  if (!cat) { toast('Select category'); return; }

  const list = Teams.all();
  list.push({
    teamName: name, coachName: coach,
    teamType: type.value, category: cat.value,
    players
  });
  Teams.save(list);

  toast('Team Saved (' + players.length + ' players)');
  regClear();
  back();
};

/* ============================================================
   REGISTERED TEAMS
   ============================================================ */

function renderTeams() {
  const q = $('#teamSearch').value.trim().toLowerCase();
  const all = Teams.all();

  const match = t => !q
    || (t.teamName || '').toLowerCase().includes(q)
    || (t.coachName || '').toLowerCase().includes(q);

  const box = $('#teamGroups');
  box.innerHTML = '';

  let shown = 0, menShown = 0;

  [['Men', '👨 Men Teams', 'var(--yellow)'], ['Women', '👩 Women Teams', 'var(--pink)']]
    .forEach(([type, title, colour]) => {

      const sideTeams = all.filter(t => (t.teamType || 'Men') === type);
      let sideShown = 0;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h2>${title}</h2>`;

      ['U14', 'U18', 'Open'].forEach(cat => {
        const list = sideTeams.filter(t => (t.category || 'Open') === cat).filter(match);
        if (q && !list.length) return; // hide empty sections while searching

        const h = document.createElement('h3');
        h.textContent = cat;
        h.style.color = colour;
        card.appendChild(h);

        if (!list.length) {
          const e = document.createElement('div');
          e.className = 'empty';
          e.textContent = 'None';
          card.appendChild(e);
          return;
        }

        list.forEach(t => {
          sideShown++;
          card.appendChild(teamRow(t));
        });
      });

      if (q && !sideShown) return; // hide the whole side when nothing matches

      shown += sideShown;
      if (type === 'Men') menShown = sideShown;
      box.appendChild(card);
    });

  const info = $('#teamSearchInfo');

  if (!q) {
    info.style.display = 'none';
  } else {
    info.style.display = '';
    info.textContent = shown === 0
      ? `No team matches "${$('#teamSearch').value}"`
      : `${shown} of ${all.length} teams   •   ${menShown} men, ${shown - menShown} women`;
  }

  if (!all.length) box.innerHTML = '<div class="card empty">No teams registered yet</div>';
}

function teamRow(team) {
  const row = document.createElement('div');
  row.className = 'listrow';

  row.innerHTML = `
    <div class="grow pick">
      <div class="name">${esc(team.teamName)}</div>
      <div class="meta">${team.players.length} players • Coach: ${esc(team.coachName)}</div>
    </div>`;

  row.querySelector('.grow').onclick = () => showTeamDetail(team);

  const del = document.createElement('button');
  del.className = 'red';
  del.textContent = '🗑';
  del.onclick = async () => {
    if (await ask('Delete Team', 'Delete ' + team.teamName + '?', { yes: 'Delete' }) !== 'yes') return;
    Teams.save(Teams.all().filter(t => t.teamName !== team.teamName));
    toast('Team Deleted');
    renderTeams();
  };
  row.appendChild(del);

  return row;
}

$('#teamSearch').addEventListener('input', renderTeams);

function showTeamDetail(team) {
  $('#tdName').textContent = team.teamName;
  $('#tdMeta').textContent = `Coach: ${team.coachName}  •  ${team.teamType} ${team.category}`
                           + `  •  ${team.players.length} players`;
  $('#tdPlayers').innerHTML = team.players
    .map((p, i) => `<div class="listrow"><div class="grow">🔹 ${i + 1}. ${esc(p)}</div></div>`)
    .join('');
  go('teamdetail');
}

/* ============================================================
   MATCH SELECTION
   ============================================================ */

let selPool = [];       // teams of the chosen type + category
let selPicked = [];     // chosen teams, held by object not index

function renderSelect() {
  const type = $('input[name=selType]:checked').value;
  const cat = $('input[name=selCat]:checked').value;

  selPool = Teams.all().filter(t =>
    (t.teamType || 'Men') === type && (t.category || 'Open') === cat);

  selPicked = selPicked.filter(t => selPool.includes(t));

  applySelSearch();
}

function applySelSearch() {
  const q = $('#selSearch').value.trim().toLowerCase();

  const visible = selPool.filter(t => !q
    || (t.teamName || '').toLowerCase().includes(q)
    || (t.coachName || '').toLowerCase().includes(q));

  const box = $('#selList');
  box.innerHTML = '';

  if (!visible.length) {
    box.innerHTML = '<div class="empty">'
      + (selPool.length ? 'No team matches that search'
                        : 'No teams registered in this type and category')
      + '</div>';
  }

  visible.forEach(t => {
    const row = document.createElement('div');
    row.className = 'listrow pick' + (selPicked.includes(t) ? ' sel' : '');
    row.innerHTML = `<div class="grow">
        <div class="name">${selPicked.includes(t) ? '✅ ' : ''}${esc(t.teamName)}</div>
        <div class="meta">${t.players.length} players • Coach: ${esc(t.coachName)}</div>
      </div>`;

    row.onclick = () => {
      const i = selPicked.indexOf(t);
      if (i >= 0) selPicked.splice(i, 1);
      else if (selPicked.length < 2) selPicked.push(t);
      else { toast('Two teams already selected - tap one to remove it'); return; }
      applySelSearch();
    };

    box.appendChild(row);
  });

  // a picked team hidden by the search still counts, so say so
  let info;
  if (!selPicked.length) {
    info = 'Select 2 teams';
  } else {
    info = 'Selected: ' + selPicked.map(t => t.teamName).join('  vs  ');
    if (selPicked.length === 1) info += '   (pick 1 more)';
  }

  if (q) {
    const hidden = selPicked.filter(t => !visible.includes(t)).length;
    info += `\n${visible.length} of ${selPool.length} shown`;
    if (hidden) info += `   •   ${hidden} selected not shown`;
  }

  $('#selInfo').style.whiteSpace = 'pre-line';
  $('#selInfo').textContent = info;
}

$$('input[name=selType], input[name=selCat]').forEach(r => r.addEventListener('change', renderSelect));
$('#selSearch').addEventListener('input', applySelSearch);

$('#toTossBtn').onclick = () => {
  if (selPicked.length !== 2) { toast('Select exactly 2 teams'); return; }
  openToss(selPicked[0], selPicked[1]);
};

/* ============================================================
   TOSS
   ============================================================ */

let tossTeams = null;

function openToss(t1, t2) {
  tossTeams = [t1, t2];

  $('#tossDate').value = todayIso();
  $('#tossTeams').textContent = t1.teamName + '   vs   ' + t2.teamName;

  $('#tossAttack').innerHTML = [t1, t2].map((t, i) =>
    `<label class="opt"><input type="radio" name="tossAtk" value="${i}"${i === 0 ? ' checked' : ''}>
     ${esc(t.teamName)}</label>`).join('');

  go('toss');
}

$$('input[name=dreamRun]').forEach(r => r.addEventListener('change', () => {
  $('#bonusField').style.display = $('input[name=dreamRun]:checked').value === '0' ? 'none' : '';
}));

$('#toPlayersBtn').onclick = () => {
  const iso = $('#tossDate').value;
  if (!iso) { toast('Pick a match date'); return; }

  const atkIndex = Number($('input[name=tossAtk]:checked').value);
  const minutes = Number($('input[name=halfTime]:checked').value);
  const dreamRun = Number($('input[name=dreamRun]:checked').value);

  if (dreamRun > 0 && dreamRun >= minutes) {
    toast(`Dream Run (${dreamRun} min) must be shorter than the ${minutes} min half`, 4000);
    return;
  }

  pendingSetup = {
    attacking: tossTeams[atkIndex],
    defending: tossTeams[1 - atkIndex],
    matchDate: isoToDisplay(iso),
    minutesPerHalf: minutes,
    attackPlayers: Number($('input[name=attackSize]:checked').value),
    wicketPoints: Number($('input[name=wicketPts]:checked').value),
    dreamRunMinutes: dreamRun,
    bonusIntervalSeconds: Number($('input[name=bonusEvery]:checked').value)
  };

  openPlayerSelection();
};

/* ============================================================
   PERMANENT SUBS
   ============================================================ */

let pendingSetup = null;
let perm1 = [], perm2 = [];

function openPlayerSelection() {
  perm1 = []; perm2 = [];

  $('#ps1Title').textContent = pendingSetup.attacking.teamName;
  $('#ps2Title').textContent = pendingSetup.defending.teamName;

  renderPermList('#ps1List', pendingSetup.attacking, perm1);
  renderPermList('#ps2List', pendingSetup.defending, perm2);

  go('players');
}

function renderPermList(sel, team, store) {
  const box = $(sel);
  box.innerHTML = '';

  team.players.forEach((name, i) => {
    const num = String(i + 1);

    const row = document.createElement('div');
    row.className = 'listrow pick' + (store.includes(num) ? ' sel' : '');
    row.innerHTML = `<div class="grow"><div class="name">${store.includes(num) ? '🔴 ' : ''}${num}. ${esc(name)}</div></div>`;

    row.onclick = () => {
      const at = store.indexOf(num);
      if (at >= 0) store.splice(at, 1);
      else if (store.length < 3) store.push(num);
      else { toast('Max 3 permanent subs'); return; }
      renderPermList(sel, team, store);
    };

    box.appendChild(row);
  });
}

$('#toScoringBtn').onclick = () => {
  const playing1 = pendingSetup.attacking.players.length - perm1.length;
  const playing2 = pendingSetup.defending.players.length - perm2.length;

  if (playing1 < 3 || playing2 < 3) {
    toast('Each team needs at least 3 players left after the permanent subs', 4000);
    return;
  }

  Scoring.start(pendingSetup, perm1.slice(), perm2.slice());
};

/* ============================================================
   SCORE SHEETS
   ============================================================ */

function renderSheets() {
  const all = Matches.all();
  const q = $('#sheetSearch').value.trim().toLowerCase();

  const hit = m => !q || [m.team1Name, m.team2Name, m.date, m.winner, m.category]
    .some(v => v && String(v).toLowerCase().includes(q));

  const box = $('#sheetList');
  box.innerHTML = '';

  const groups = new Map();
  let shown = 0;

  for (let i = all.length - 1; i >= 0; i--) {   // newest first
    const m = all[i];
    if (!hit(m)) continue;
    m.__index = i;                      // position in the stored list, used when editing
    const d = m.date || 'No Date';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(m);
    shown++;
  }

  $('#sheetTotal').textContent = q
    ? `Showing ${shown} of ${all.length}`
    : `Total Matches : ${all.length}`;

  if (!shown) {
    box.innerHTML = `<div class="card empty">${all.length
      ? 'No match found for "' + esc($('#sheetSearch').value) + '"'
      : 'No matches saved yet'}</div>`;
    return;
  }

  groups.forEach((list, date) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>📅 ${esc(date)}</h2>`;

    list.forEach(m => {
      const draw = isDraw(m);
      const row = document.createElement('div');
      row.className = 'listrow';
      row.innerHTML = `<div class="grow pick">
          <div class="name">${esc(m.team1Name)} vs ${esc(m.team2Name)}</div>
          <div class="meta">${m.team1Score} - ${m.team2Score} • ${draw ? 'Draw' : '🏆 ' + esc(m.winner)}</div>
        </div>`;

      row.querySelector('.grow').onclick = () => showDetail(m, m.__index);

      const del = document.createElement('button');
      del.className = 'red';
      del.textContent = '🗑';
      del.onclick = async () => {
        if (await ask('Delete Match', `Delete ${m.team1Name} vs ${m.team2Name}?`, { yes: 'Delete' }) !== 'yes') return;
        const l = Matches.all();
        const idx = typeof m.__index === 'number' ? m.__index : -1;
        if (idx >= 0 && idx < l.length) { l.splice(idx, 1); Matches.save(l); }
        toast('Match Deleted');
        renderSheets();
      };
      row.appendChild(del);

      card.appendChild(row);
    });

    box.appendChild(card);
  });
}

$('#sheetSearch').addEventListener('input', renderSheets);

function isDraw(m) {
  return m.winner !== m.team1Name && m.winner !== m.team2Name;
}
