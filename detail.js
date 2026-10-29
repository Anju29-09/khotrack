/* Match detail and export.
 *
 * Mirrors MatchDetailActivity: the same half titles, the same per-half attacking side
 * used to resolve jersey numbers to the right squad, and the same Dream Run summary.
 *
 * PDF comes from the browser's own print-to-PDF rather than a bundled PDF library, so
 * there is nothing to download and it works offline on every platform.
 */

/** Badge colour per age category; anything unrecognised falls back to the Open green. */
const CAT_COLOURS = {
  U14: '#2563EB', U17: '#0EA5E9', U18: '#7C3AED', U19: '#DB2777', OPEN: '#059669'
};

let detailMatch = null;

/** Index of the shown match inside the stored list; null means it cannot be edited. */
let detailIndex = null;

let editing = false;

function halfTitle(m, i) {
  if (m.halfTitles && i < m.halfTitles.length && m.halfTitles[i]) return m.halfTitles[i];
  return ['1st Inning - 1st Half', '1st Inning - 2nd Half',
          '2nd Inning - 1st Half', '2nd Inning - 2nd Half',
          '3rd Inning - 1st Half', '3rd Inning - 2nd Half'][i] || ('Half ' + (i + 1));
}

function halfCode(m, i) {
  const t = halfTitle(m, i);
  if (t.startsWith('Sudden Death')) return t.includes('1st') ? 'SD1' : 'SD2';
  const inn = t.startsWith('1st') ? 'I1' : t.startsWith('2nd') ? 'I2'
            : t.startsWith('3rd') ? 'I3' : 'H' + (i + 1);
  const half = t.includes('1st Half') ? 'H1' : t.includes('2nd Half') ? 'H2' : '';
  return inn + half;
}

/** true if team1 was attacking in that half; legacy matches alternate from team1. */
function wasTeam1Attacking(m, i) {
  if (m.halfTeam1Attacking && i < m.halfTeam1Attacking.length
      && typeof m.halfTeam1Attacking[i] === 'boolean') {
    return m.halfTeam1Attacking[i];
  }
  return i % 2 === 0;
}

const halfBonusOf = (m, i) =>
  (m.halfBonus && typeof m.halfBonus[i] === 'number') ? m.halfBonus[i] : 0;

/** "5. Amit Deshmukh", or just "5." when the name is unknown. */
function numName(jersey, name) {
  if (!jersey) return '';
  if (jersey === '-') return '-';   // recorded without naming the player
  return jersey + '.' + (name ? ' ' + name : '');
}

function squadName(m, jersey, fromTeam1) {
  if (!jersey) return '';

  let squad = fromTeam1 ? m.team1Players : m.team2Players;

  if (!squad) {   // saved before squads were stored - fall back to the team list
    const t = Teams.byName(fromTeam1 ? m.team1Name : m.team2Name);
    squad = t && t.players;
  }
  if (!squad) return '';

  const i = parseInt(jersey, 10) - 1;
  return (i >= 0 && i < squad.length) ? squad[i] : '';
}

/** Flattens the match into printable rows, names already resolved. */
function sheetRows(m) {
  const rows = [];
  const events = m.allEvents || [];

  for (let h = 0; h < events.length; h++) {
    const batches = events[h] || [];
    const times = (m.allTimes || [])[h] || [];
    const types = (m.allTypes || [])[h] || [];
    const t1Att = wasTeam1Attacking(m, h);

    for (let i = 0; i < batches.length; i++) {

      let firstOfBatch = true;

      for (let j = 0; j < batches[i].length; j++) {
        const raw = batches[i][j];
        if (!raw || raw === '-') continue;

        const time = (times[i] && times[i][j]) || '-';
        const type = (types[i] && types[i][j]) || '-';

        let defNo = raw.trim(), attNo = '';
        if (raw.includes('-by-')) {
          const parts = raw.split('-by-');
          defNo = (parts[0] || '').trim();
          attNo = (parts[1] || '').trim();

          // a self out is stored as "3-by--", so the attacker side is the "-"
          // placeholder rather than a real jersey
          if (attNo === '-') attNo = '';
        }

        // the defender belongs to the defending side of that half
        const defName = squadName(m, defNo, !t1Att);
        const attName = squadName(m, attNo, t1Att);

        const notOut = time === 'Not Out';
        const label = numName(defNo, defName)
          + (notOut || !attNo ? '' : ' - by - ' + numName(attNo, attName));

        rows.push({
          halfIndex: h,
          batchIndex: i,
          eventIndex: j,
          half: halfTitle(m, h),
          batchNo: i + 1,
          batch: 'Batch ' + (i + 1),
          firstOfBatch,
          defNo, defName, attNo, attName,
          time, type, notOut, label
        });

        firstOfBatch = false;   // the label shows once, on the batch's first line
      }
    }
  }

  return rows;
}

/**
 * Every attacker's wicket count for the whole match, grouped by team.
 *
 * Grouping by team matters: jersey 5 of one side is a different player from jersey 5
 * of the other, so their tallies must never be merged.
 */
function matchSummary(m, rows) {
  const teams = new Map();

  // seed both sides so a team that took nothing is still listed, in a stable order
  teams.set(m.team1Name, new Map());
  teams.set(m.team2Name, new Map());

  rows.forEach(r => {
    // not outs and self outs have no attacker to credit
    if (r.notOut || !r.attNo) return;

    const team = wasTeam1Attacking(m, r.halfIndex) ? m.team1Name : m.team2Name;

    if (!teams.has(team)) teams.set(team, new Map());

    const jerseys = teams.get(team);
    const had = jerseys.get(r.attNo);

    jerseys.set(r.attNo, {
      name: (had && had.name) || r.attName,
      count: (had ? had.count : 0) + 1
    });
  });

  return Array.from(teams.entries()).map(([name, jerseys]) => ({
    name,
    pairs: Array.from(jerseys.entries())
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([jersey, v]) => ({ jersey, player: v.name, count: v.count }))
  }));
}

/** "5. Amit - 4,  7. Kiran - 1", or a dash when the side took nothing. */
function pairsText(pairs) {
  if (!pairs.length) return '-';
  return pairs.map(p => numName(p.jersey, p.player) + ' - ' + p.count).join(',   ');
}

function sectionLabel(m, i) {
  const bonus = halfBonusOf(m, i);
  if (!bonus) return halfTitle(m, i);
  const defending = wasTeam1Attacking(m, i) ? m.team2Name : m.team1Name;
  return `${halfTitle(m, i)}   ⭐ Dream Run +${bonus} ${defending}`;
}

function rulesLine(m) {
  let s = (m.wicketPoints || 1) + ' point(s) per wicket';
  if (m.attackPlayers) s += '  |  ' + m.attackPlayers + '-player attack';
  s += m.dreamRunMinutes
    ? `  |  Dream Run ${m.dreamRunMinutes} min, bonus every ${m.bonusIntervalSeconds || 30} sec`
    : '  |  No Dream Run';
  return s;
}

function showDetail(m, index) {
  detailMatch = m;
  detailIndex = (typeof index === 'number') ? index : null;
  editing = false;
  renderDetail();
  go('detail');
}

/** Redraws the detail screen for the current match and edit state. */
function renderDetail() {
  const m = detailMatch;
  const draw = isDraw(m);

  const cat = m.category || (Teams.byName(m.team1Name) || {}).category || 'Open';
  const badge = $('#dtBadge');
  badge.textContent = m.teamType ? m.teamType + ' • ' + cat : cat;
  badge.style.background = CAT_COLOURS[cat.toUpperCase()] || '#059669';

  $('#dtTitle').textContent = `${m.team1Name} vs ${m.team2Name}`;
  $('#dtDate').textContent = (m.date || 'No Date')
    + (m.minutesPerHalf ? `  •  ${m.minutesPerHalf} min halves` : '');

  const w = $('#dtWinner');
  w.textContent = draw ? '🤝 Match Draw' : '🏆 Winner: ' + m.winner;
  w.style.color = draw ? 'var(--yellow)' : 'var(--green)';

  $('#dt1Name').textContent = m.team1Name;
  $('#dt2Name').textContent = m.team2Name;
  $('#dt1').textContent = m.team1Score;
  $('#dt2').textContent = m.team2Score;
  $('#dtRules').textContent = rulesLine(m);

  const rows = sheetRows(m);
  const table = $('#dtTable');

  let html = '<tr><th>Batch</th><th>Wicket</th><th>Time</th><th>Type</th></tr>';
  let currentHalf = null;

  rows.forEach(r => {
    if (r.half !== currentHalf) {
      currentHalf = r.half;
      html += `<tr class="section"><td colspan="4">${esc(sectionLabel(m, r.halfIndex))}</td></tr>`;
    }

    const idx = rows.indexOf(r);

    html += `<tr${editing ? ` data-row="${idx}" class="editable"` : ''}>`
          + `<td>${r.firstOfBatch ? esc(r.batch) : ''}</td>`
          + `<td>${editing ? '✏️ ' : ''}${esc(r.label)}</td>`
          + `<td class="${r.notOut ? 'notout' : ''}">${esc(r.time)}</td><td>${esc(r.type)}</td></tr>`;
  });

  if (!rows.length) html += '<tr><td colspan="4" class="empty">No ball-by-ball data recorded</td></tr>';

  // one tally for the whole match, once every inning is done
  if (rows.length) {
    html += '<tr class="tally"><td colspan="4">Wickets Taken — Match Total</td></tr>';

    matchSummary(m, rows).forEach(t => {
      html += `<tr class="tally team"><td colspan="4">${esc(t.name)} — `
            + `${esc(pairsText(t.pairs))}</td></tr>`;
    });
  }

  table.innerHTML = html;

  // in edit mode every wicket line opens the row editor
  if (editing) {
    table.querySelectorAll('tr[data-row]').forEach(tr => {
      tr.onclick = () => openRowEditor(rows[Number(tr.dataset.row)]);
    });
  }

  $('#editBtn').style.display = detailIndex === null ? 'none' : '';
  $('#editPanel').style.display = editing ? '' : 'none';
  $('#editBtn').textContent = editing ? '✏️ Editing…' : '✏️ Edit';
}

/* ============================================================
   EDIT
   ============================================================

   Corrections are made on a working copy and only written to storage on Save, so
   Cancel always leaves the saved match exactly as it was.
*/

let editBackup = null;

function startEdit() {
  if (detailIndex === null) { toast('This match cannot be edited'); return; }

  editBackup = JSON.parse(JSON.stringify(detailMatch));
  editing = true;

  const m = detailMatch;

  $('#edDate').value = m.date || '';
  $('#edName1').textContent = m.team1Name;
  $('#edName2').textContent = m.team2Name;
  $('#edScore1').value = m.team1Score;
  $('#edScore2').value = m.team2Score;

  $('#edWinner').innerHTML =
      `<option value="${esc(m.team1Name)}">${esc(m.team1Name)}</option>`
    + `<option value="${esc(m.team2Name)}">${esc(m.team2Name)}</option>`
    + '<option value="Draw">Draw</option>';

  $('#edWinner').value = isDraw(m) ? 'Draw' : m.winner;

  renderDetail();
  toast('Edit mode - tap a row to change it');
}

function cancelEdit() {
  detailMatch = editBackup || detailMatch;
  editBackup = null;
  editing = false;
  renderDetail();
  toast('Changes discarded');
}

function saveEdit() {
  const m = detailMatch;

  const s1 = parseInt($('#edScore1').value, 10);
  const s2 = parseInt($('#edScore2').value, 10);

  if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0) {
    toast('Scores must be whole numbers');
    return;
  }

  m.date = $('#edDate').value.trim() || m.date;
  m.team1Score = s1;
  m.team2Score = s2;
  m.winner = $('#edWinner').value;

  const all = Matches.all();

  if (detailIndex < 0 || detailIndex >= all.length) {
    toast('Could not find this match in storage');
    return;
  }

  all[detailIndex] = m;
  Matches.save(all);

  editBackup = null;
  editing = false;
  renderDetail();
  toast('Scoresheet updated');
}

/** Rebuilds both scores from the sheet, after rows have been corrected. */
function recalcScores() {
  const m = detailMatch;
  const pts = m.wicketPoints || 1;

  let s1 = 0, s2 = 0;

  (m.allEvents || []).forEach((batches, h) => {
    const t1Att = wasTeam1Attacking(m, h);

    let outs = 0;
    (batches || []).forEach(b => b.forEach(e => { if (e.includes('-by-')) outs++; }));

    // wickets score for the attacking side, Dream Run points for the defending side
    if (t1Att) { s1 += outs * pts; s2 += halfBonusOf(m, h); }
    else       { s2 += outs * pts; s1 += halfBonusOf(m, h); }
  });

  $('#edScore1').value = s1;
  $('#edScore2').value = s2;

  $('#edWinner').value = s1 > s2 ? m.team1Name : s2 > s1 ? m.team2Name : 'Draw';

  toast(`Recalculated: ${s1} - ${s2}`);
}

/* ---- one wicket ---- */

let rowBeingEdited = null;

function openRowEditor(r) {
  rowBeingEdited = r;

  $('#rowWhere').textContent = `${r.half}  •  ${r.batch}`;
  $('#rowDef').value = r.defNo;
  $('#rowAtt').value = r.attNo;
  $('#rowTime').value = r.time;
  $('#rowType').value = r.notOut ? '' : (r.type === '-' ? '' : r.type);

  $('#dlgRow').showModal();
}

/** Writes the edited values back into the match's own arrays. */
function applyRowEdit() {
  const r = rowBeingEdited;
  if (!r) return;

  const m = detailMatch;
  const def = $('#rowDef').value.trim();

  if (!def) { toast('Defender jersey is required'); return; }

  const att = $('#rowAtt').value.trim();
  const time = $('#rowTime').value.trim() || '00:00';
  const type = $('#rowType').value;

  const notOut = time.toLowerCase() === 'not out';

  // a not out has no attacker at all; a self out keeps the "-" placeholder
  const event = notOut ? def
    : (att ? def + '-by-' + att : def + '-by--');

  m.allEvents[r.halfIndex][r.batchIndex][r.eventIndex] = event;
  m.allTimes[r.halfIndex][r.batchIndex][r.eventIndex] = notOut ? 'Not Out' : time;
  m.allTypes[r.halfIndex][r.batchIndex][r.eventIndex] = notOut ? '' : type;

  $('#dlgRow').close();
  rowBeingEdited = null;
  renderDetail();
  toast('Row updated - remember to Save');
}

async function deleteRow() {
  const r = rowBeingEdited;
  if (!r) return;

  $('#dlgRow').close();

  if (await ask('Delete Wicket', `Remove "${r.label}" from the sheet?`,
      { yes: 'Delete' }) !== 'yes') {
    rowBeingEdited = null;
    return;
  }

  const m = detailMatch;

  m.allEvents[r.halfIndex][r.batchIndex].splice(r.eventIndex, 1);
  m.allTimes[r.halfIndex][r.batchIndex].splice(r.eventIndex, 1);
  m.allTypes[r.halfIndex][r.batchIndex].splice(r.eventIndex, 1);

  rowBeingEdited = null;
  renderDetail();
  toast('Row deleted - remember to Save');
}

$('#editBtn').onclick = () => editing ? cancelEdit() : startEdit();
$('#edSaveBtn').onclick = saveEdit;
$('#edCancelBtn').onclick = cancelEdit;
$('#edRecalcBtn').onclick = recalcScores;

$('#rowOkBtn').onclick = applyRowEdit;
$('#rowCancelBtn').onclick = () => { $('#dlgRow').close(); rowBeingEdited = null; };
$('#rowDeleteBtn').onclick = deleteRow;

/* ---------------- export ---------------- */

function exportName(m, ext) {
  const clean = `${m.team1Name} vs ${m.team2Name} ${m.date || ''}`
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'match';
  return 'Scoresheet_' + clean + '.' + ext;
}

function sheetText(m) {
  let s = `${m.team1Name} vs ${m.team2Name}\n${m.date || ''}\n`;
  s += `${m.team1Name} : ${m.team1Score}\n${m.team2Name} : ${m.team2Score}\n`;
  s += (isDraw(m) ? 'Match Draw' : 'Winner: ' + m.winner) + '\n';
  s += rulesLine(m) + '\n';

  let half = null;
  sheetRows(m).forEach(r => {
    if (r.half !== half) {
      half = r.half;
      s += `\n========== ${sectionLabel(m, r.halfIndex)} ==========\n`;
      s += 'Batch | Wicket | Time | Type\n';
    }
    s += `${r.firstOfBatch ? r.batch : ''} | ${r.label} | ${r.time} | ${r.type}\n`;
  });

  s += `\n---- Wickets Taken — Match Total ----\n`;

  matchSummary(m, sheetRows(m)).forEach(t => {
    s += `${t.name} — ${pairsText(t.pairs)}\n`;
  });

  return s;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(m) {
  let s = '';
  s += `Match,${csvCell(m.team1Name + ' vs ' + m.team2Name)}\n`;
  s += `Date,${csvCell(m.date)}\n`;
  s += `Result,${csvCell(isDraw(m) ? 'Draw' : m.winner)}\n`;
  s += `${csvCell(m.team1Name)},${m.team1Score}\n`;
  s += `${csvCell(m.team2Name)},${m.team2Score}\n`;
  s += `Rules,${csvCell(rulesLine(m))}\n\n`;

  if (m.dreamRunMinutes) {
    s += 'Half,Dream Run Bonus,Awarded To\n';
    (m.allEvents || []).forEach((_, h) => {
      const defending = wasTeam1Attacking(m, h) ? m.team2Name : m.team1Name;
      s += `${csvCell(halfTitle(m, h))},${halfBonusOf(m, h)},${csvCell(defending)}\n`;
    });
    s += '\n';
  }

  s += 'Half,Batch,Defender No,Defender Name,Attacker No,Attacker Name,'
     + 'Time,Type,Result\n';

  sheetRows(m).forEach(r => {
    s += [r.half, r.batch, r.defNo, r.defName, r.attNo, r.attName,
          r.time, r.type, r.notOut ? 'Not Out' : 'Out'].map(csvCell).join(',') + '\n';
  });

  s += '\nWickets Taken In Match\n';
  s += 'Team,Jersey,Player,Wickets\n';

  matchSummary(m, sheetRows(m)).forEach(t => {
    if (!t.pairs.length) {
      s += [t.name, '', '', 0].map(csvCell).join(',') + '\n';
      return;
    }
    t.pairs.forEach(p => {
      s += [t.name, p.jersey, p.player, p.count].map(csvCell).join(',') + '\n';
    });
  });

  return s;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#printBtn').onclick = () => window.print();

$('#csvBtn').onclick = () => {
  if (!detailMatch) return;
  download(exportName(detailMatch, 'csv'), buildCsv(detailMatch), 'text/csv;charset=utf-8');
  toast('CSV downloaded');
};

$('#shareBtn').onclick = async () => {
  if (!detailMatch) return;
  const text = sheetText(detailMatch);
  const title = `${detailMatch.team1Name} vs ${detailMatch.team2Name}`;

  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('Scoresheet copied to clipboard');
  } catch (e) {
    toast('Sharing is not available in this browser');
  }
};
