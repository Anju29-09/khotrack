/* A very small PDF writer, just enough for a score sheet.
 *
 * Written here rather than pulled from a CDN so the sheet still exports with no
 * internet, which is the whole point of the app being installable. It handles
 * one thing: lines of Helvetica text laid out in columns over A4 pages.
 *
 * PDF strings are WinAnsi, so anything outside Latin-1 is folded to an ASCII
 * stand-in before it reaches the file.
 */

const Pdf = (() => {

  const PAGE = { w: 595.28, h: 841.89 };
  const MARGIN = 40;

  /* Helvetica is close enough to half the point size per character for laying out
     a table; the columns are generous so a few points either way do not show. */
  const widthOf = (text, size, bold) => text.length * size * (bold ? 0.55 : 0.5);

  const SUBS = {
    '⭐': '*', '•': '-', '—': '-', '–': '-',
    '‘': "'", '’': "'", '“': '"', '”': '"',
    ' ': ' ', '…': '...'
  };

  /** Folds anything a PDF string cannot carry into plain ASCII. */
  function ascii(text) {
    return String(text == null ? '' : text)
      .replace(/[⭐•—–‘’“” …]/g, c => SUBS[c])
      .replace(/[^\x20-\xFF]/g, '')        // emoji and the rest simply go
      .replace(/\s+/g, ' ')
      .trim();
  }

  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  /** Breaks text into lines that fit a given width. */
  function wrap(text, size, bold, maxWidth) {
    const words = ascii(text).split(' ');
    const lines = [];
    let line = '';

    words.forEach(w => {
      const next = line ? line + ' ' + w : w;
      if (line && widthOf(next, size, bold) > maxWidth) { lines.push(line); line = w; }
      else line = next;
    });

    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /**
   * Collects text into pages, then serialises them.
   *
   * Call text()/row()/rule()/gap() in order; the sheet is laid out top to bottom
   * and a new page starts on its own when the current one runs out.
   */
  function doc() {
    const pages = [];
    let ops = [];
    let y = 0;

    const newPage = () => {
      if (ops.length) pages.push(ops);
      ops = [];
      y = PAGE.h - MARGIN;
    };

    newPage();

    const room = need => { if (y - need < MARGIN + 24) newPage(); };

    const put = (s, x, size, bold) => {
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td `
        + `(${esc(ascii(s))}) Tj ET`);
    };

    return {
      /** One line of text, wrapped to the page width. */
      text(s, { size = 9, bold = false, gapAfter = 4, x = MARGIN } = {}) {
        wrap(s, size, bold, PAGE.w - MARGIN - x).forEach(line => {
          room(size + 4);
          y -= size + 2;
          put(line, x, size, bold);
        });
        y -= gapAfter;
      },

      /** A table row: cells are [text, x, width] and wrap inside their column. */
      row(cells, { size = 8, bold = false } = {}) {
        const stacks = cells.map(c => wrap(c[0], size, bold, c[2]));
        const lines = Math.max(...stacks.map(s => s.length));

        room(lines * (size + 2) + 4);

        const top = y;
        stacks.forEach((stack, i) => {
          y = top;
          stack.forEach(line => { y -= size + 2; put(line, cells[i][1], size, bold); });
        });
        y = top - lines * (size + 2);
      },

      rule() {
        room(8);
        y -= 6;
        ops.push(`0.75 w 0.6 0.6 0.6 RG ${MARGIN} ${y.toFixed(2)} m `
          + `${(PAGE.w - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
        y -= 6;
      },

      gap(h = 8) { y -= h; },

      /** Serialises everything written so far into PDF bytes. */
      build() {
        if (ops.length) pages.push(ops);

        const objs = [];
        const add = body => { objs.push(body); return objs.length; };   // 1-based

        const catalog = add('');          // 1, filled in below
        const pagesObj = add('');         // 2
        const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
          + '/Encoding /WinAnsiEncoding >>');
        const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold '
          + '/Encoding /WinAnsiEncoding >>');

        const kids = [];

        pages.forEach((pageOps, i) => {
          const stream = pageOps.join('\n');
          const contentNo = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
          const pageNo = add(`<< /Type /Page /Parent ${pagesObj} 0 R `
            + `/MediaBox [0 0 ${PAGE.w} ${PAGE.h}] `
            + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> `
            + `/Contents ${contentNo} 0 R >>`);
          kids.push(`${pageNo} 0 R`);
        });

        objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
        objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] `
          + `/Count ${kids.length} >>`;

        let out = '%PDF-1.4\n';
        const offsets = [];

        objs.forEach((body, i) => {
          offsets.push(out.length);
          out += `${i + 1} 0 obj\n${body}\nendobj\n`;
        });

        const xref = out.length;

        out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
        offsets.forEach(o => { out += String(o).padStart(10, '0') + ' 00000 n \n'; });
        out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\n`
             + `startxref\n${xref}\n%%EOF`;

        // every character is a byte here, so the offsets above are byte offsets
        const bytes = new Uint8Array(out.length);
        for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;

        return new Blob([bytes], { type: 'application/pdf' });
      }
    };
  }

  return { doc, PAGE, MARGIN };
})();
