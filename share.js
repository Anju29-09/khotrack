/* Registration by message.
 *
 * Straight port of TeamShare.java so a form sent from the Android app can be read
 * here and vice versa. Deliberately forgiving: the text is typed by hand and travels
 * through a chat app, so quoting marks, stray blank lines, missing labels and odd
 * capitalisation all have to survive.
 */
const TeamShare = (() => {

  const HEADER = 'KHOKHO TEAM';
  const MAX_PLAYERS = 15;

  function buildTemplate() {
    let s = HEADER + '\n';
    s += 'Fill in the blanks and send this message back.\n\n';
    s += 'Team: \nCoach: \nType (Men/Women): \nCategory (U14/U18/Open): \n\n';
    s += 'Players:\n';
    for (let i = 1; i <= MAX_PLAYERS; i++) s += i + '. \n';
    s += '\nAt least 9 players. Leave the extra numbers blank.';
    return s;
  }

  function buildFilled(team) {
    let s = HEADER + '\n\n';
    s += 'Team: ' + team.teamName + '\n';
    s += 'Coach: ' + team.coachName + '\n';
    s += 'Type (Men/Women): ' + team.teamType + '\n';
    s += 'Category (U14/U18/Open): ' + team.category + '\n\n';
    s += 'Players:\n';
    team.players.forEach((p, i) => { s += (i + 1) + '. ' + p + '\n'; });
    return s;
  }

  /** Strips the decoration chat apps and forwarded quotes leave behind. */
  function clean(line) {
    let s = line.trim();
    while (s && '>*-•|'.includes(s[0])) s = s.slice(1).trim();
    return s.replace(/\*/g, '').replace(/_/g, ' ').trim();
  }

  /** Turns "7." / "7)" / "7 -" into just the name. */
  function stripNumbering(line) {
    let s = line.trim();
    let i = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;

    if (i > 0 && i < s.length) {
      if ('.):- '.includes(s[i])) s = s.slice(i + 1).trim();
    } else if (i > 0) {
      return ''; // a line that is only a number is an empty slot
    }

    while (s && '.)-'.includes(s[0])) s = s.slice(1).trim();
    return s;
  }

  /** The template's own instruction lines must not be read as players. */
  function isNote(line) {
    const l = line.toLowerCase();
    return l.startsWith('at least') || l.startsWith('fill in')
        || l.startsWith('minimum') || l.startsWith('leave the extra');
  }

  function normaliseType(v) {
    const l = v.toLowerCase();
    if (l.includes('women') || l.includes('girl') || l.includes('female')) return 'Women';
    if (l.includes('men') || l.includes('boy') || l.includes('male')) return 'Men';
    return '';
  }

  function normaliseCategory(v) {
    const l = v.toLowerCase().replace(/\s/g, '');
    if (l.includes('u14') || l.includes('under14')) return 'U14';
    if (l.includes('u18') || l.includes('under18')) return 'U18';
    if (l.includes('open')) return 'Open';
    return '';
  }

  /** @return the parsed team, or null if the message is not a registration */
  function parse(text) {
    if (!text) return null;

    const out = { teamName: '', coachName: '', teamType: '', category: '', players: [] };
    let inPlayers = false;

    for (const raw of text.split(/\r?\n/)) {
      const line = clean(raw);
      if (!line) continue;

      if (inPlayers) {
        const p = stripNumbering(line);
        if (!p || isNote(p)) continue;
        if (out.players.length < MAX_PLAYERS) out.players.push(p);
        continue;
      }

      const colon = line.indexOf(':');
      if (colon < 0) continue;

      const key = line.slice(0, colon).toLowerCase().trim();
      const value = line.slice(colon + 1).trim();

      if (key.startsWith('players')) {
        inPlayers = true;
        // "Players: Amit, Rohan, ..." on one line is accepted too
        if (value) {
          for (const part of value.split(',')) {
            const p = stripNumbering(clean(part));
            if (p && out.players.length < MAX_PLAYERS) out.players.push(p);
          }
        }
      } else if (key.startsWith('team'))     out.teamName = value;
      else if (key.startsWith('coach'))      out.coachName = value;
      else if (key.startsWith('type'))       out.teamType = normaliseType(value);
      else if (key.startsWith('category'))   out.category = normaliseCategory(value);
    }

    return (out.teamName || out.players.length) ? out : null;
  }

  return { HEADER, MAX_PLAYERS, buildTemplate, buildFilled, parse };
})();
