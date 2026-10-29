/* Live scoring.
 *
 * A faithful port of MatchScoringActivity: same phases, same batch/cycle rules, same
 * manual Lap behaviour (automatic only in sudden death), same Dream Run maths, and the
 * same crash-safe draft so an accidental close never loses a match.
 */

const Scoring = (() => {

  let M = null;            // the match being scored (this is what gets saved as the draft)
  let timer = null;        // setInterval handle
  let endAt = 0;           // wall-clock time the half runs out
  let running = false;
  let wakeLock = null;

  // transient selection state, never part of the draft
  let selAttacker = null;
  let selDefender = null;
  let selDefenders = [];
  let autoLapPending = false;

  const phaseTitle = p => ({
    1: '1st Inning - 1st Half', 2: '1st Inning - 2nd Half',
    3: '2nd Inning - 1st Half', 4: '2nd Inning - 2nd Half',
    5: '3rd Inning - 1st Half', 6: '3rd Inning - 2nd Half',
    7: 'Sudden Death - 1st Half', 8: 'Sudden Death - 2nd Half'
  }[p] || ('Half ' + p));

  /* ---------------- lifecycle ---------------- */

  function start(setup, perm1, perm2) {
    const total = setup.minutesPerHalf * 60000;

    M = {
      team1: setup.attacking,
      team2: setup.defending,
      perm1, perm2,
      matchDate: setup.matchDate,
      minutesPerHalf: setup.minutesPerHalf,
      attackPlayers: setup.attackPlayers,
      wicketPoints: setup.wicketPoints,
      dreamRunMs: setup.dreamRunMinutes * 60000,
      bonusIntervalMs: setup.bonusIntervalSeconds * 1000,

      team1Score: 0, team2Score: 0,
      currentPhase: 1,
      isTeam1Attacking: true,
      isSuddenDeath: false,
      sdFirstWicketMs: 0,
      sdWinner: null,

      cycleCount: 1,
      currentBatchIndex: 0,
      totalTime: total,
      timeLeft: total,
      lastWicketTime: 0,
      currentLapTime: 0,

      batches: [], batchEvents: [], batchTimes: [], batchTypes: [],
      batchStart: [], batchBonus: [],

      allHalfEvents: [], allHalfTimes: [], allHalfTypes: [],
      halfTitles: [], halfTeam1Attacking: [], halfBonus: [],

      currentHalfArchived: false,
      undoStack: []
    };

    buildPlaying();
    enter();
  }

  function resume(draft) {
    M = draft;

    // defensive defaults for drafts written by an older build
    M.undoStack = M.undoStack || [];
    M.batchStart = M.batchStart || [];
    M.batchBonus = M.batchBonus || [];
    M.halfBonus = M.halfBonus || [];
    M.wicketPoints = M.wicketPoints || 1;
    M.dreamRunMs = M.dreamRunMs || 0;
    M.bonusIntervalMs = M.bonusIntervalMs || 30000;
    M.currentHalfArchived = false;   // a resumed half is always still open

    buildPlaying();
    enter();
    toast('Unfinished match resumed');
  }

  function buildPlaying() {
    const out = (team, perm) => team.players
      .map((_, i) => String(i + 1))
      .filter(n => !perm.includes(n));

    M.playing1 = out(M.team1, M.perm1);
    M.playing2 = out(M.team2, M.perm2);
  }

  function enter() {
    running = false;
    endAt = 0;
    selAttacker = selDefender = null;
    selDefenders = [];
    autoLapPending = false;

    go('scoring');
    renderAll();
    saveDraft();
  }

  /* ---------------- draft ---------------- */

  function saveDraft() {
    if (!M) return;
    const copy = Object.assign({}, M);
    delete copy.playing1;           // rebuilt from the squads on resume
    delete copy.playing2;
    DB.write('liveMatchDraft', copy);
  }

  function closeDraft() { DB.remove('liveMatchDraft'); }

  /* ---------------- timer ---------------- */

  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not supported, or denied - harmless */ }
  }

  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  function startTimer() {
    if (M.timeLeft <= 0) { toast('This half is over'); return; }

    endAt = Date.now() + M.timeLeft;
    running = true;
    requestWake();

    clearInterval(timer);
    timer = setInterval(tick, 200);

    renderTimer();
  }

  function pauseTimer() {
    clearInterval(timer);
    timer = null;
    M.timeLeft = Math.max(0, endAt - Date.now());
    running = false;
    endAt = 0;
    releaseWake();
    renderTimer();
    saveDraft();
    toast('Timer paused');
  }

  function tick() {
    M.timeLeft = Math.max(0, endAt - Date.now());
    renderTimer();
    checkDreamRun();

    if (M.timeLeft <= 0) {
      clearInterval(timer);
      timer = null;
      running = false;
      endAt = 0;
      releaseWake();
      handleRemainingNotOuts();
      handleNextPhase();
    }
  }

  function resetHalfTimer() {
    clearInterval(timer);
    timer = null;
    running = false;
    endAt = 0;
    M.timeLeft = M.totalTime;
    M.lastWicketTime = 0;
    M.currentLapTime = 0;
    releaseWake();
    renderTimer();
  }

  /** Records the gap since the previous lap. Only Lap calls this outside sudden death. */
  function captureLap() {
    const elapsed = M.totalTime - M.timeLeft;
    M.currentLapTime = Math.max(0, elapsed - M.lastWicketTime);
    M.lastWicketTime = elapsed;
  }

  /* ---------------- dream run ---------------- */

  function checkDreamRun() {
    if (!M.dreamRunMs || !M.bonusIntervalMs) return;
    if (!running) return;
    if (M.currentBatchIndex >= M.batches.length) return;
    if (M.currentBatchIndex >= M.batchStart.length) return;

    const survival = (M.totalTime - M.timeLeft) - M.batchStart[M.currentBatchIndex];
    if (survival < M.dreamRunMs) return;

    // one point on reaching the Dream Run, then one per interval after it
    const due = 1 + Math.floor((survival - M.dreamRunMs) / M.bonusIntervalMs);

    while (M.batchBonus[M.currentBatchIndex] < due) {
      M.batchBonus[M.currentBatchIndex]++;

      if (M.isTeam1Attacking) M.team2Score++; else M.team1Score++;

      toast('Dream Run  +1  ' + defendingName());
    }

    renderScore();
    renderGameData();
    saveDraft();
  }

  const halfBonusPoints = () => M.batchBonus.reduce((a, b) => a + (b || 0), 0);

  /* ---------------- names ---------------- */

  const attackingName = () => M.isTeam1Attacking ? M.team1.teamName : M.team2.teamName;
  const defendingName = () => M.isTeam1Attacking ? M.team2.teamName : M.team1.teamName;

  function playerName(num, attackerSide) {
    const team = attackerSide
      ? (M.isTeam1Attacking ? M.team1 : M.team2)
      : (M.isTeam1Attacking ? M.team2 : M.team1);

    const i = parseInt(num, 10) - 1;
    return (i >= 0 && i < team.players.length) ? team.players[i] : '';
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    $('#sc1Name').textContent = M.team1.teamName;
    $('#sc2Name').textContent = M.team2.teamName;
    renderScore();
    renderTimer();
    renderPhase();
    renderPlayers();
    renderGameData();
    renderPerm();
  }

  function renderScore() {
    $('#sc1').textContent = M.team1Score;
    $('#sc2').textContent = M.team2Score;
  }

  function renderTimer() {
    const t = $('#timerText');
    t.textContent = fmtTime(M.timeLeft);
    t.classList.toggle('low', M.timeLeft <= 30000);

    const b = $('#startBtn');
    if (running) {
      b.textContent = 'Pause';
      b.className = 'amber';
    } else {
      b.textContent = M.timeLeft === M.totalTime ? 'Start' : 'Resume';
      b.className = 'green';
    }

    $('#undoBtn').disabled = !M.undoStack.length;
  }

  function renderPhase() {
    $('#inningText').textContent = phaseTitle(M.currentPhase);
    $('#attLabel').textContent = 'Attacking\n' + attackingName();
    $('#defLabel').textContent = 'Defending\n' + defendingName();
    $('#attLabel').style.whiteSpace = 'pre-line';
    $('#defLabel').style.whiteSpace = 'pre-line';

    const sd = $('#sdTarget');
    if (M.currentPhase === 8) {
      sd.style.display = '';
      sd.textContent = 'Target Time: ' + fmtTime(M.sdFirstWicketMs);
    } else {
      sd.style.display = 'none';
    }

    const canFinish = [2, 4, 6, 8].includes(M.currentPhase);
    $('#finishBtn').style.display = canFinish ? '' : 'none';
    $('#skipBtn').style.display = M.currentPhase === 3 ? '' : 'none';
  }

  function renderPerm() {
    const fmt = list => list.length ? list.join('  ') : '-';
    $('#permText').textContent =
      `Permanent — ${M.team1.teamName}: ${fmt(M.perm1)}   |   ${M.team2.teamName}: ${fmt(M.perm2)}`;
  }

  /**
   * Colour state of a defender, scoped to the cycle being played.
   *
   * A defender turns green when picked into a batch and red once their wicket falls,
   * and keeps that colour for the rest of the cycle. When all three batches are done
   * and the cycle repeats, everyone starts fresh and goes green again as they are
   * picked, so the field always reads as the current cycle.
   */
  function defenderState(num) {
    if (num === '-') return 'none';

    const first = Math.floor(M.currentBatchIndex / 3) * 3;   // batches of this cycle
    const last = first + 3;

    for (let i = first; i < last && i < M.batchEvents.length; i++) {
      if (M.batchEvents[i].some(e => e.startsWith(num + '-by-'))) return 'out';
    }

    for (let i = first; i < last && i < M.batches.length; i++) {
      if (M.batches[i].includes(num)) return 'picked';
    }

    // the batch being picked right now is not in the list yet
    if (selDefenders.includes(num)) return 'picked';

    return 'none';
  }

  function alreadyOut(num) {
    const ev = M.batchEvents[M.currentBatchIndex];
    return !!ev && ev.some(e => e.startsWith(num + '-by-'));
  }

  function renderPlayers() {
    const attackers = M.isTeam1Attacking ? M.playing1 : M.playing2;
    const defenders = M.isTeam1Attacking ? M.playing2 : M.playing1;

    const attBox = $('#attGrid');
    const defBox = $('#defGrid');
    attBox.innerHTML = '';
    defBox.innerHTML = '';

    attackers.concat('-').forEach(n => {
      const b = document.createElement('div');
      b.className = 'jersey' + (selAttacker === n ? ' att-sel' : '');
      b.textContent = n;
      b.title = playerName(n, true);
      b.onclick = () => { selAttacker = n; renderPlayers(); };
      attBox.appendChild(b);
    });

    defenders.concat('-').forEach(n => {
      const b = document.createElement('div');

      let cls = 'jersey def';
      const state = defenderState(n);
      if (state === 'out') cls += ' out';
      else if (state === 'picked') cls += ' def-sel';

      b.className = cls;
      b.textContent = n;
      b.title = playerName(n, false);
      b.onclick = () => onDefender(n);
      defBox.appendChild(b);
    });

    renderKeyStatus();
  }

  function renderGameData() {
    const box = $('#gameData');
    box.innerHTML = '';

    if (!M.batches.length) {
      box.innerHTML = '<div class="empty">Tap 3 defenders on the right to start a batch</div>';
      return;
    }

    M.batches.forEach((batch, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'batch';

      const bonus = M.batchBonus[i] || 0;
      const head = document.createElement('div');
      head.className = 'head' + (i === M.currentBatchIndex ? ' live' : '');
      head.innerHTML = `<span>Cycle ${Math.floor(i / 3) + 1} - Batch ${(i % 3) + 1} - [${batch.join(', ')}]`
        + (bonus ? `   ⭐ Dream Run +${bonus}` : '') + '</span>';

      const del = document.createElement('button');
      del.textContent = '🗑';
      del.onclick = () => deleteBatch(i);
      head.appendChild(del);

      wrap.appendChild(head);

      const rows = M.batchEvents[i]
        .map((e, j) => {
          if (e === '-') return '';
          const t = M.batchTimes[i][j];
          const notOut = t === 'Not Out';
          return `<tr><td>${esc(e)}</td><td class="t${notOut ? ' notout' : ''}">${esc(t)}</td>`
               + `<td class="y">${esc(M.batchTypes[i][j])}</td></tr>`;
        }).join('');

      if (rows) {
        wrap.insertAdjacentHTML('beforeend',
          `<table><tr><th>Wicket</th><th>Time</th><th>Type</th></tr>${rows}</table>`);
      }

      box.appendChild(wrap);
    });
  }

  /* ---------------- defender / wicket ---------------- */

  function requiredOuts(batch) {
    return Math.max(1, batch.filter(p => p !== '-').length);
  }

  function onDefender(num) {
    // building the next batch of 3
    if (M.currentBatchIndex >= M.batches.length) {
      const at = selDefenders.indexOf(num);
      if (at >= 0) selDefenders.splice(at, 1);
      else if (selDefenders.length < 3) selDefenders.push(num);
      else { toast('Only 3 defenders allowed'); return; }

      if (selDefenders.length === 3) addBatch();
      renderPlayers();
      return;
    }

    // giving a wicket
    // '-' records a wicket without naming the defender, so it is not held to the
    // current batch and may be used as often as the scorer needs
    if (num !== '-') {
      if (!M.batches[M.currentBatchIndex].includes(num)) {
        toast('Jersey ' + num + ' is not in this batch ('
          + M.batches[M.currentBatchIndex].join(', ') + ')', 3500);
        return;
      }
      if (alreadyOut(num)) { toast('Player already out'); return; }
    }
    if (!running) { toast('Start the timer first'); return; }

    // Sudden death is decided on time, so a wicket here can never be left at 00:00.
    // Every other half keeps the manual Lap behaviour.
    if (M.isSuddenDeath && M.currentLapTime === 0) {
      captureLap();
      autoLapPending = true;
    }

    selDefender = num;
    askAttackType();
  }

  function addBatch() {
    if (M.batches.length >= 3 * M.cycleCount) return;

    M.batches.push(selDefenders.slice());
    M.batchEvents.push([]);
    M.batchTimes.push([]);
    M.batchTypes.push([]);
    M.batchStart.push(M.totalTime - M.timeLeft);   // the Dream Run clock is per batch
    M.batchBonus.push(0);

    selDefenders = [];
    renderPlayers();
    renderGameData();
    saveDraft();
  }

  /**
   * Once all three batches are out the same three come round again, so the scorer
   * never re-enters the same jerseys. Returns false when the finished group was not
   * a full three batches, in which case the next batch is picked by hand as before.
   */
  function repeatCycle() {
    const first = M.batches.length - 3;
    if (first < 0 || M.batches.length % 3 !== 0) return false;

    for (let i = first; i < first + 3; i++) {
      M.batches.push(M.batches[i].slice());
      M.batchEvents.push([]);
      M.batchTimes.push([]);
      M.batchTypes.push([]);
      M.batchStart.push(M.totalTime - M.timeLeft);
      M.batchBonus.push(0);
    }

    return true;
  }

  function askAttackType() {
    const dlg = $('#dlgAttack');

    const cleanup = () => {
      dlg.querySelectorAll('[data-type]').forEach(b => b.onclick = null);
      $('#dlgAttackCancel').onclick = null;
    };

    const cancel = () => {
      dlg.close(); cleanup(); cancelPending();
    };

    dlg.querySelectorAll('[data-type]').forEach(b => {
      b.onclick = () => {
        const type = b.dataset.type;

        // '-' is a valid attacker on any wicket type: the wicket still counts, it
        // is simply recorded with nobody credited for it
        dlg.close(); cleanup();
        processWicket(type);
      };
    });

    $('#dlgAttackCancel').onclick = cancel;
    dlg.addEventListener('cancel', cancel, { once: true });
    dlg.showModal();
  }

  function cancelPending() {
    // an automatic sudden death lap belonged to this wicket only - give the time back
    if (autoLapPending) {
      M.lastWicketTime = Math.max(0, M.lastWicketTime - M.currentLapTime);
      M.currentLapTime = 0;
      autoLapPending = false;
    }
    selDefender = null;
  }

  function processWicket(type) {
    const bi = M.currentBatchIndex;
    if (bi >= M.batchEvents.length || !selDefender) { cancelPending(); return; }
    if (selDefender !== '-' && alreadyOut(selDefender)) {
      toast('Player already out'); cancelPending(); return;
    }

    // a self out, or an attacker left as '-', both credit nobody
    const attacker = (type === 'Self Out' || !selAttacker) ? '-' : selAttacker;
    const event = selDefender + '-by-' + attacker;

    const lap = M.currentLapTime;

    M.batchEvents[bi].push(event);
    M.batchTimes[bi].push(fmtTime(lap));
    M.batchTypes[bi].push(type);

    if (M.isTeam1Attacking) M.team1Score += M.wicketPoints;
    else M.team2Score += M.wicketPoints;

    M.currentLapTime = 0;
    autoLapPending = false;
    selAttacker = null;
    selDefender = null;

    renderScore();
    renderPlayers();
    renderGameData();

    // ---- sudden death ----
    if (M.isSuddenDeath && M.currentPhase === 7 && M.sdFirstWicketMs === 0) {
      M.sdFirstWicketMs = lap;
      M.undoStack = [];
      toast('Target Time = ' + fmtTime(lap), 4000);
      archiveHalf();
      clearInterval(timer); timer = null; running = false; releaseWake();
      handleNextPhase();
      return;
    }

    if (M.isSuddenDeath && M.currentPhase === 8) {
      archiveHalf();
      clearInterval(timer); timer = null; running = false; releaseWake();
      M.undoStack = [];

      M.sdWinner = lap < M.sdFirstWicketMs ? attackingName() : defendingName();

      renderTimer();
      $('#finishBtn').style.display = '';
      saveDraft();

      ask('Sudden Death Result',
        `${M.sdWinner} Wins!\n\nTarget ${fmtTime(M.sdFirstWicketMs)}   •   This wicket ${fmtTime(lap)}`,
        { yes: 'OK', no: 'Close' });
      return;
    }

    // ---- next batch once this one is all out ----
    const outs = M.batchEvents[bi].filter(e => e.includes('-by-')).length;
    let advanced = false, newCycle = false;

    let cloned = 0;

    if (outs >= requiredOuts(M.batches[bi])) {
      M.currentBatchIndex++;
      advanced = true;

      if (M.currentBatchIndex >= M.batches.length) {
        M.cycleCount++;
        newCycle = true;

        if (repeatCycle()) {
          cloned = 3;
          toast('New Cycle - same batches again');
        } else {
          M.currentBatchIndex = M.batches.length;
          toast('New Cycle - pick the next 3 defenders');
        }

      } else {
        toast('Next Batch');
      }

      // the batch now on the field starts its own Dream Run clock
      if (M.currentBatchIndex < M.batchStart.length) {
        M.batchStart[M.currentBatchIndex] = M.totalTime - M.timeLeft;
      }

      renderPlayers();
      renderGameData();
    }

    M.undoStack.push({
      batch: bi,
      team1: M.isTeam1Attacking,
      advanced, newCycle, cloned,
      lap, points: M.wicketPoints
    });

    renderTimer();
    saveDraft();
  }

  /* ---------------- undo / delete / reset ---------------- */

  async function undoLast() {
    if (!M.undoStack.length) { toast('Nothing to undo'); return; }

    const last = M.undoStack[M.undoStack.length - 1];
    const ev = M.batchEvents[last.batch];

    if (!ev || !ev.length) { M.undoStack.pop(); renderTimer(); return; }

    const label = ev[ev.length - 1];
    if (await ask('Undo Last Wicket', 'Remove ' + label + ' from the sheet?', { yes: 'Undo' }) !== 'yes') return;

    M.undoStack.pop();

    const j = ev.length - 1;
    ev.splice(j, 1);
    M.batchTimes[last.batch].splice(j, 1);
    M.batchTypes[last.batch].splice(j, 1);

    if (last.team1) M.team1Score = Math.max(0, M.team1Score - last.points);
    else M.team2Score = Math.max(0, M.team2Score - last.points);

    if (last.newCycle && M.cycleCount > 1) M.cycleCount--;

    // remove the batches the new cycle brought in, so undo leaves no empty ones behind
    for (let k = 0; k < (last.cloned || 0); k++) {
      [M.batches, M.batchEvents, M.batchTimes, M.batchTypes, M.batchStart, M.batchBonus]
        .forEach(arr => arr.pop());
    }

    if (last.advanced) M.currentBatchIndex = last.batch;

    // The undone wicket also consumed a lap. Wind the baseline back so the next lap is
    // measured from where the previous one ended, not from a wicket that no longer exists.
    M.lastWicketTime = Math.max(0, M.lastWicketTime - last.lap);
    if (M.currentLapTime > 0) M.currentLapTime += last.lap;

    renderScore(); renderTimer(); renderPlayers(); renderGameData();
    saveDraft();
    toast('Wicket undone');
  }

  /** Keyboard delete: the batch on the field, or the last one picked if none is live. */
  function deleteCurrentBatch() {
    if (!M.batches.length) { toast('No batch to delete'); return; }

    const index = M.currentBatchIndex < M.batches.length
      ? M.currentBatchIndex
      : M.batches.length - 1;

    deleteBatch(index);
  }

  async function deleteBatch(index) {
    if (await ask('Delete Batch',
      `Delete Batch ${index + 1} [${(M.batches[index] || []).join(', ')}]? `
      + 'The wickets recorded in it are removed from the score too.',
      { yes: 'Delete' }) !== 'yes') return;

    if (index >= M.batches.length) return;

    const outs = (M.batchEvents[index] || []).filter(e => e.includes('-by-')).length;
    const bonus = M.batchBonus[index] || 0;

    if (M.isTeam1Attacking) {
      M.team1Score = Math.max(0, M.team1Score - outs * M.wicketPoints);
      M.team2Score = Math.max(0, M.team2Score - bonus);
    } else {
      M.team2Score = Math.max(0, M.team2Score - outs * M.wicketPoints);
      M.team1Score = Math.max(0, M.team1Score - bonus);
    }

    [M.batches, M.batchEvents, M.batchTimes, M.batchTypes, M.batchStart, M.batchBonus]
      .forEach(arr => arr.splice(index, 1));

    selDefenders = [];
    selAttacker = selDefender = null;
    M.undoStack = [];                       // indexes no longer line up
    M.currentBatchIndex = M.batches.length;

    renderScore(); renderTimer(); renderPlayers(); renderGameData();
    saveDraft();
    toast('Batch Deleted');
  }

  async function resetHalf() {
    if (await ask('Reset Half',
      `Start ${phaseTitle(M.currentPhase)} again?\n\nThe clock goes back to ${fmtTime(M.totalTime)} `
      + 'and every batch and wicket recorded in this half is deleted.',
      { yes: 'Reset' }) !== 'yes') return;

    let outs = 0;
    M.batchEvents.forEach(ev => outs += ev.filter(e => e.includes('-by-')).length);
    const bonus = halfBonusPoints();

    if (M.isTeam1Attacking) {
      M.team1Score = Math.max(0, M.team1Score - outs * M.wicketPoints);
      M.team2Score = Math.max(0, M.team2Score - bonus);
    } else {
      M.team2Score = Math.max(0, M.team2Score - outs * M.wicketPoints);
      M.team1Score = Math.max(0, M.team1Score - bonus);
    }

    resetInning();
    resetHalfTimer();
    renderScore();
    saveDraft();

    const removed = outs * M.wicketPoints + bonus;
    toast(removed ? `Half reset - ${removed} point(s) removed` : 'Half reset');
  }

  function resetInning() {
    M.batches = []; M.batchEvents = []; M.batchTimes = []; M.batchTypes = [];
    M.batchStart = []; M.batchBonus = [];
    M.undoStack = [];
    M.currentBatchIndex = 0;
    M.cycleCount = 1;
    M.currentHalfArchived = false;

    selDefenders = [];
    selAttacker = selDefender = null;
    autoLapPending = false;

    renderPlayers();
    renderGameData();
    renderTimer();
  }

  /* ---------------- half / phase flow ---------------- */

  function handleRemainingNotOuts() {
    if (M.currentBatchIndex >= M.batches.length) return;

    const batch = M.batches[M.currentBatchIndex];
    const ev = M.batchEvents[M.currentBatchIndex];
    const ti = M.batchTimes[M.currentBatchIndex];
    const ty = M.batchTypes[M.currentBatchIndex];

    batch.forEach(p => {
      if (p === '-') return;
      // either already out, or already listed as not out by an earlier call
      if (ev.some(e => e.startsWith(p + '-by-') || e === p)) return;
      ev.push(p); ti.push('Not Out'); ty.push('');
    });

    renderGameData();
  }

  function archiveHalf() {
    if (M.currentHalfArchived) return;

    const deep = a => a.map(r => r.slice());

    M.allHalfEvents.push(deep(M.batchEvents));
    M.allHalfTimes.push(deep(M.batchTimes));
    M.allHalfTypes.push(deep(M.batchTypes));
    M.halfTitles.push(phaseTitle(M.currentPhase));
    M.halfTeam1Attacking.push(M.isTeam1Attacking);
    M.halfBonus.push(halfBonusPoints());

    M.currentHalfArchived = true;
  }

  async function handleNextPhase() {
    // sudden death halves are archived by processWicket the moment the wicket lands
    if (!M.isSuddenDeath || M.currentPhase < 7) archiveHalf();

    // sudden death 1st half ran out with no wicket: the full half becomes the target
    if (M.isSuddenDeath && M.currentPhase === 7 && M.sdFirstWicketMs === 0) {
      M.sdFirstWicketMs = M.totalTime;
      archiveHalf();
      toast('No wicket in the 1st half - target is the full ' + fmtTime(M.totalTime), 4000);
    }

    if (M.currentPhase < 4) {
      M.currentPhase++;

    } else if (M.currentPhase === 4) {

      if (M.team1Score === M.team2Score) { await tieBreaker(); return; }
      readyToFinish();
      return;

    } else if (M.currentPhase === 5) {
      M.currentPhase = 6;

    } else if (M.currentPhase === 7 && M.isSuddenDeath) {
      M.currentPhase = 8;

    } else if (M.currentPhase === 6 && !M.isSuddenDeath) {

      // 3rd inning ended level - offer sudden death instead of a silent draw
      if (M.team1Score === M.team2Score) { await suddenDeath(); return; }
      readyToFinish();
      return;

    } else if (M.currentPhase === 8) {
      readyToFinish();
      return;
    }

    nextHalf();
  }

  function readyToFinish() {
    toast('Match Ready to Finish');
    renderPhase();
    $('#finishBtn').style.display = '';
    saveDraft();
  }

  function nextHalf() {
    M.isTeam1Attacking = !M.isTeam1Attacking;
    resetInning();
    resetHalfTimer();
    renderPhase();
    renderPerm();
    saveDraft();
    toast(phaseTitle(M.currentPhase));
  }

  async function tieBreaker() {
    const pick = await choose('Scores Level', 'How should the tie be broken?', [
      { label: '3rd Inning', value: '3rd' },
      { label: 'Sudden Death', value: 'sd', cls: 'purple' }
    ]);

    if (pick === '3rd') { M.currentPhase = 5; nextHalf(); return; }
    await suddenDeath();
  }

  async function suddenDeath() {
    const r = await ask('Start Sudden Death', 'Scores are level. Start sudden death?',
      { yes: 'Yes', no: 'Finish as Draw' });

    if (r !== 'yes') { readyToFinish(); return; }

    M.isSuddenDeath = true;
    M.sdFirstWicketMs = 0;
    M.sdWinner = null;
    M.currentPhase = 7;
    nextHalf();
  }

  /* ---------------- finish / exit ---------------- */

  async function confirmFinish() {
    if (await ask('Finish Match', 'Are you sure you want to finish the match?', { yes: 'Finish' }) !== 'yes') return;

    clearInterval(timer); timer = null; running = false; releaseWake();

    // if the ref finishes while a half is still open, keep that half's data
    if (!M.currentHalfArchived && M.batches.length) {
      handleRemainingNotOuts();
      archiveHalf();
    }

    let winner;
    if (M.sdWinner) {
      // sudden death is settled on time, so its result outranks the points
      winner = M.sdWinner;
    } else if (M.team1Score > M.team2Score) {
      winner = M.team1.teamName;
    } else if (M.team2Score > M.team1Score) {
      winner = M.team2.teamName;
    } else {
      winner = 'Draw';
    }

    const match = {
      team1Name: M.team1.teamName,
      team2Name: M.team2.teamName,
      date: M.matchDate,
      team1Score: M.team1Score,
      team2Score: M.team2Score,
      winner,
      allEvents: M.allHalfEvents,
      allTimes: M.allHalfTimes,
      allTypes: M.allHalfTypes,
      halfTitles: M.halfTitles,
      halfTeam1Attacking: M.halfTeam1Attacking,
      halfBonus: M.halfBonus,
      team1Players: M.team1.players.slice(),
      team2Players: M.team2.players.slice(),
      category: M.team1.category,
      teamType: M.team1.teamType,
      minutesPerHalf: M.minutesPerHalf,
      attackPlayers: M.attackPlayers,
      wicketPoints: M.wicketPoints,
      dreamRunMinutes: Math.round(M.dreamRunMs / 60000),
      bonusIntervalSeconds: Math.round(M.bonusIntervalMs / 1000)
    };

    Matches.add(match);
    closeDraft();
    toast('Match Finished');

    M = null;
    // the match was just appended, so it is the last entry in storage
    showDetail(match, Matches.all().length - 1);
  }

  async function confirmExit() {
    const r = await ask('Leave Match',
      'This match is not finished. It stays saved and you can resume it from the home screen.',
      { yes: 'Leave', no: 'Stay', alt: 'Discard Match' });

    if (r === 'no') return;

    if (r === 'alt') {
      if (await ask('Discard Match', 'Delete this match permanently?', { yes: 'Discard' }) !== 'yes') return;
      closeDraft();
    } else {
      saveDraft();
    }

    clearInterval(timer); timer = null; running = false; releaseWake();
    M = null;
    go('home');
  }

  /* ---------------- wiring ---------------- */

  $('#startBtn').onclick = () => { if (!M) return; running ? pauseTimer() : startTimer(); };

  $('#lapBtn').onclick = () => {
    if (!M) return;
    captureLap();
    toast('Time marked: ' + fmtTime(M.currentLapTime));
  };

  $('#undoBtn').onclick = () => M && undoLast();
  $('#resetHalfBtn').onclick = () => M && resetHalf();
  $('#finishBtn').onclick = () => M && confirmFinish();
  $('#scoringBackBtn').onclick = () => M ? confirmExit() : go('home');

  $('#skipBtn').onclick = async () => {
    if (!M) return;
    if (M.currentPhase !== 3) { toast('Skip allowed only in 2nd Inning 1st Half'); return; }
    if (await ask('Skip Inning', 'Are you sure you want to skip this inning?', { yes: 'Skip' }) !== 'yes') return;

    archiveHalf();
    M.currentPhase = 4;
    M.isTeam1Attacking = !M.isTeam1Attacking;
    resetInning();
    resetHalfTimer();
    renderPhase();
    renderPerm();
    saveDraft();
    toast('Inning Skipped');
  };

  /* ============================================================
     KEYBOARD SHORTCUTS  (laptop / PC)
     ============================================================

     Nothing here changes the touch flow - a phone simply never fires these events,
     and the on-screen help is hidden by CSS on touch devices.

     Jerseys are entered as two digits so 1 and 12 can never be confused: "01" is
     jersey 1, "12" is jersey 12 and "00" is the "-" placeholder. While a batch is
     being built each entry toggles a defender into it; once the batch is live the
     first entry is the attacker and the second is the defender, which then opens the
     attack type box exactly as tapping does.
  */

  let keyBuf = '';
  let keyTimer = null;

  /** Highest jersey in play, so we know when a digit can still grow into a bigger one. */
  function maxJersey() {
    const all = M.playing1.concat(M.playing2).map(n => parseInt(n, 10) || 0);
    return all.length ? Math.max.apply(null, all) : 0;
  }

  /** Could this partial entry still become a valid two-digit jersey? */
  function couldGrow(buf) {
    if (buf === '0') return true;                     // 00-09 are still possible
    return parseInt(buf + '0', 10) <= maxJersey();    // e.g. "1" -> 10..15 exist
  }

  /**
   * Digits commit as soon as they can only mean one thing, so a squad of 15 needs
   * a single keypress for jerseys 2-9 and no waiting at all. "1" pauses briefly in
   * case a second digit follows (1 vs 12), and Enter always commits immediately.
   */
  function pushDigit(d) {
    clearTimeout(keyTimer);
    keyBuf += d;

    if (keyBuf.length >= 2 || !couldGrow(keyBuf)) { commitKey(); return; }

    keyTimer = setTimeout(commitKey, 900);
    renderKeyStatus();
  }

  function commitKey() {
    clearTimeout(keyTimer);
    keyTimer = null;

    const buf = keyBuf;
    keyBuf = '';

    if (buf) applyJersey(buf);
    renderKeyStatus();
  }

  function clearKeyEntry() {
    clearTimeout(keyTimer);
    keyTimer = null;
    keyBuf = '';
  }

  function renderKeyStatus() {
    const el = $('#keyStatus');
    if (!el) return;

    if (!M) { el.textContent = ''; return; }

    const buildingBatch = M.currentBatchIndex >= M.batches.length;
    const typed = keyBuf ? `<span class="live">${keyBuf}_</span>` : '';

    let s;
    if (buildingBatch) {
      s = `Picking batch — ${3 - selDefenders.length} more defender(s). Type two digits: ${typed || '__'}`;
    } else if (!selAttacker) {
      s = `Type the <span class="att">attacker</span>'s two digits: ${typed || '__'}`;
    } else {
      s = `Attacker <span class="att">${selAttacker}</span> → type the `
        + `<span class="def">defender</span>'s two digits: ${typed || '__'}`;
    }

    el.innerHTML = s;
  }

  /** Resolves a completed two-digit entry to a jersey and acts on it. */
  function applyJersey(digits) {
    const n = parseInt(digits, 10);
    const num = n === 0 ? '-' : String(n);   // 0 and 00 both mean "no jersey"



    // building the next batch: the entry is a defender toggle
    if (M.currentBatchIndex >= M.batches.length) {
      const defenders = M.isTeam1Attacking ? M.playing2 : M.playing1;
      if (num !== '-' && !defenders.includes(num)) {
        toast('No defender ' + num + '.  Available: ' + defenders.join(', '), 3500);
        return;
      }
      onDefender(num);
      return;
    }

    // first entry of a live batch is the attacker
    if (!selAttacker) {
      const attackers = M.isTeam1Attacking ? M.playing1 : M.playing2;
      if (num !== '-' && !attackers.includes(num)) {
        toast('No attacker ' + num + '.  Available: ' + attackers.join(', '), 3500);
        return;
      }
      selAttacker = num;
      renderPlayers();
      return;
    }

    // second entry is the defender, which opens the attack type box
    onDefender(num);
  }

  document.addEventListener('keydown', e => {
    if (!M) return;
    if (!$('#s-scoring').classList.contains('active')) return;

    // never steal keys from a text box or an open dialog
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // space is the one clock key: start, then pause, then resume
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();          // also stops it activating a focused button
      if (running) pauseTimer(); else startTimer();
      return;
    }

    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pushDigit(e.key);
      return;
    }

    // Enter commits a half-typed jersey without waiting for the pause
    if (e.key === 'Enter') {
      e.preventDefault();
      commitKey();
      return;
    }

    // one lookup, lower-cased, so every shortcut works with or without Caps Lock
    switch ((e.key || '').toLowerCase()) {

      case 'escape':
        clearKeyEntry();
        selAttacker = null;
        selDefender = null;
        renderPlayers();
        renderKeyStatus();
        toast('Selection cleared');
        break;

      case 'backspace':
        e.preventDefault();
        clearTimeout(keyTimer);
        keyBuf = keyBuf.slice(0, -1);
        renderKeyStatus();
        break;

      case 'l':
        e.preventDefault();
        captureLap();
        toast('Time marked: ' + fmtTime(M.currentLapTime));
        break;

      case 'u':
        e.preventDefault();
        undoLast();
        break;

      case 'h':
        e.preventDefault();
        resetHalf();
        break;

      case 's':
        e.preventDefault();
        $('#skipBtn').click();
        break;

      case 'd':
        e.preventDefault();
        deleteCurrentBatch();
        break;

      case 'f':
        e.preventDefault();
        if ($('#finishBtn').style.display === 'none') toast('The match cannot be finished yet');
        else confirmFinish();
        break;
    }
  });

  /* 1-4 pick the attack type once the box is open. */
  $('#dlgAttack').addEventListener('keydown', e => {
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i < 0) return;

    e.preventDefault();

    // the dialog closes on click, so without this the same key would reach the
    // document handler and be read as the next wicket's attacker
    e.stopPropagation();

    $('#dlgAttack').querySelectorAll('[data-type]')[i].click();
  });

  // the browser may drop the wake lock when the tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) requestWake();
    if (document.visibilityState === 'hidden' && M) saveDraft();
  });

  window.addEventListener('beforeunload', () => { if (M) saveDraft(); });

  return { start, resume };
})();
