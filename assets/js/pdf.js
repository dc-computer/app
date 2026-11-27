// Unduh penawaran/invoice langsung sebagai file PDF (tanpa dialog cetak).
// Teks dan QR digambar sebagai vektor memakai pdf-lib (assets/lib), tata letaknya mengikuti lembar cetak di sheet.js.
import * as api from './api.js';
import { verifyUrl, paymentTerm, inWords, MATERAI_MIN, FOOT_NOTE, invoiceTerms } from './sheet.js';
import { qrMatrix } from './qr.js';
import { rupiah, qtyFmt, tglIndo, terbilang, num, toast } from './util.js';

let libPromise;
/** pdf-lib baru dimuat saat pertama kali dipakai. */
function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = new URL('../lib/pdf-lib.min.js', import.meta.url).href;
      el.onload = () => resolve(window.PDFLib);
      el.onerror = () => { el.remove(); libPromise = null; reject(new Error('Gagal memuat pembuat PDF. Periksa koneksi lalu coba lagi.')); };
      document.head.appendChild(el);
    });
  }
  return libPromise;
}

const MM = 72 / 25.4;
const PAGE = { w: 210 * MM, h: 297 * MM };
const M = { x: 15 * MM, top: 14 * MM, bottom: 16 * MM };
const W = PAGE.w - M.x * 2;

/** Logo (data URL) -> gambar PDF. Format selain PNG/JPG diubah dulu ke PNG lewat canvas. */
async function embedLogo(pdf, data) {
  if (!/^data:image\//.test(data || '')) return null;
  try {
    if (/^data:image\/png/.test(data)) return await pdf.embedPng(data);
    if (/^data:image\/jpe?g/.test(data)) return await pdf.embedJpg(data);
  } catch { /* coba lewat canvas */ }
  try {
    const img = new Image();
    img.src = data;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth || 600;
    cv.height = img.naturalHeight || 300;
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await pdf.embedPng(cv.toDataURL('image/png'));
  } catch { return null; }
}

/** Buat PDF A4 dari satu dokumen. Mengembalikan Uint8Array. */
export async function buildPdf({ doc, s, type, qrUrl }) {
  const { PDFDocument, StandardFonts, rgb } = await loadLib();
  const c = api.TYPES[type];
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${c.label} ${doc.number}`);
  pdf.setAuthor(s.company_name || '');

  const R = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const I = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const gray = (v) => rgb(v, v, v);
  const BLACK = gray(0.07);
  const SOFT = gray(0.25);
  const LINE = gray(0.73);
  const FILL = rgb(0.945, 0.953, 0.961);

  // Font standar PDF hanya mengenal karakter WinAnsi; karakter lain diganti agar tidak gagal.
  const known = new Set(R.getCharacterSet());
  const MAP = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '″': '"', '′': "'", '−': '-', '‐': '-', '‑': '-', '✓': 'v', 'Ω': 'Ohm' };
  const clean = (v) => Array.from(String(v ?? '').replace(/\t/g, ' '))
    .map((ch) => {
      if (known.has(ch.codePointAt(0))) return ch;
      if (MAP[ch]) return MAP[ch];
      if (/\s/.test(ch)) return ' ';
      const n = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      return n && Array.from(n).every((x) => known.has(x.codePointAt(0))) ? n : '?';
    }).join('');

  const width = (t, font, size) => font.widthOfTextAtSize(t, size);

  /** Pecah teks menjadi baris selebar maksimal max (menghormati baris baru). */
  function wrap(text, font, size, max) {
    const out = [];
    for (const para of String(text ?? '').split(/\r?\n/)) {
      let line = '';
      for (let word of clean(para).split(' ').filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (width(test, font, size) <= max) { line = test; continue; }
        if (line) out.push(line);
        while (word.length > 1 && width(word, font, size) > max) { // kata lebih panjang dari kolom
          let n = word.length - 1;
          while (n > 1 && width(word.slice(0, n), font, size) > max) n--;
          out.push(word.slice(0, n));
          word = word.slice(n);
        }
        line = word;
      }
      out.push(line);
    }
    return out;
  }

  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = M.top; // jarak dari tepi atas halaman
  const newPage = () => { page = pdf.addPage([PAGE.w, PAGE.h]); y = M.top; };
  const room = () => PAGE.h - M.bottom - y;
  const ensure = (h) => { if (h > room() && y > M.top) newPage(); };

  /** Satu baris teks; top = tepi atas baris. */
  function text(t, x, top, { font = R, size = 10, color = BLACK, align = 'left', w = 0 } = {}) {
    const str = clean(t);
    if (!str) return;
    const tw = width(str, font, size);
    const dx = align === 'right' ? w - tw : align === 'center' ? (w - tw) / 2 : 0;
    page.drawText(str, { x: x + dx, y: PAGE.h - top - size, font, size, color });
  }
  const lh = (size) => size * 1.4;
  function lines(arr, x, top, o = {}) {
    const step = lh(o.size || 10);
    arr.forEach((t, i) => text(t, x, top + i * step, o));
    return arr.length * step;
  }
  const hline = (x1, x2, top, thickness = 0.8, color = BLACK) =>
    page.drawLine({ start: { x: x1, y: PAGE.h - top }, end: { x: x2, y: PAGE.h - top }, thickness, color });
  const vline = (x, y1, y2, thickness = 0.8, color = BLACK) =>
    page.drawLine({ start: { x, y: PAGE.h - y1 }, end: { x, y: PAGE.h - y2 }, thickness, color });
  const box = (x, top, w, h, o) => page.drawRectangle({ x, y: PAGE.h - top - h, width: w, height: h, ...o });

  /** Teks panjang yang boleh bersambung ke halaman berikutnya. */
  function flow(arr, x, o) {
    const step = lh(o.size);
    for (const t of arr) { ensure(step); text(t, x, y, o); y += step; }
  }
  const label = (t, x, top) => text(t.toUpperCase(), x, top, { font: B, size: 8, color: gray(0.33) });

  /** QR verifikasi 26 mm dengan keterangan di bawahnya (keterangan dipusatkan pada area capX..capX+capW). */
  function drawQr(qx, qy, capX, capW) {
    const m = qrMatrix(qrUrl);
    const side = 26 * MM;
    const quiet = 2;
    const unit = side / (m.length + quiet * 2);
    box(qx, qy, side, side, { color: rgb(1, 1, 1) });
    m.forEach((row, r) => {
      // gabungkan modul gelap yang bersebelahan agar tidak muncul garis halus
      for (let i = 0; i < row.length; i++) {
        if (!row[i]) continue;
        let j = i;
        while (j + 1 < row.length && row[j + 1]) j++;
        box(qx + (i + quiet) * unit, qy + (r + quiet) * unit, (j - i + 1) * unit, unit + 0.02, { color: rgb(0, 0, 0) });
        i = j;
      }
    });
    text('Cap Digital · scan untuk verifikasi', capX, qy + side + 1, { size: 6, color: gray(0.27), align: 'center', w: capW });
  }

  /** Nomor halaman, hanya bila lebih dari satu. */
  function numberPages() {
    const pages = pdf.getPages();
    if (pages.length < 2) return;
    pages.forEach((p, i) => {
      page = p;
      text(`${doc.number}  ·  Halaman ${i + 1} dari ${pages.length}`, M.x, PAGE.h - 11 * MM, { size: 7.5, color: gray(0.4), align: 'right', w: W });
    });
  }

  if (type === 'invoice') {
    await drawInvoice();
    numberPages();
    return pdf.save();
  }

  /* ================= Invoice ================= */
  async function drawInvoice() {
    const T = await pdf.embedFont(StandardFonts.TimesRoman);
    const TB = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const black = rgb(0, 0, 0);
    const dashed = (x1, x2, top) => page.drawLine({ start: { x: x1, y: PAGE.h - top }, end: { x: x2, y: PAGE.h - top }, thickness: 0.7, color: black, dashArray: [3, 2] });
    /** Susun beberapa baris teks {t, font, size} yang dibungkus; kembalikan tingginya. */
    const para = (t, font, size, w) => wrap(t, font, size, w).map((l) => ({ t: l, font, size }));
    const heightOf = (arr) => arr.reduce((a, l) => a + lh(l.size), 0);
    const draw = (arr, x, top, o = {}) => {
      let iy = top;
      for (const l of arr) {
        const st = { ...o, font: l.font, size: l.size, color: l.color || black };
        if (l.num) text(l.num, x, iy, st);
        text(l.t, x + (l.indent || 0), iy, st);
        iy += lh(l.size);
      }
      return iy - top;
    };

    // ---- kepala: perusahaan, judul, data invoice ----
    const leftW = 72 * MM;
    const metaW = 60 * MM;
    const metaX = M.x + W - metaW;
    const logo = await embedLogo(pdf, s.logo_data);
    let lw = 0;
    let lhg = 0;
    if (logo) {
      const k = Math.min((24 * MM) / logo.width, (20 * MM) / logo.height, 1);
      lw = logo.width * k;
      lhg = logo.height * k;
      page.drawImage(logo, { x: M.x, y: PAGE.h - y - lhg, width: lw, height: lhg });
    }
    const coX = M.x + (logo ? lw + 3 * MM : 0);
    const coW = M.x + leftW - coX;
    const co = [
      ...para(s.company_name, TB, 10, coW),
      ...(s.address ? para(s.address, T, 10, coW) : []),
      ...(s.phone ? para('Telp : ' + s.phone, T, 10, coW) : []),
      ...(s.email ? para('Email : ' + s.email, T, 10, coW) : []),
    ];
    let ly = y + Math.max(draw(co, coX, y), lhg) + 5 * MM;
    const custX = M.x + 62;
    const cust = [
      ...para(doc.customer_name, TB, 10, M.x + leftW - custX),
      ...(doc.customer_address ? para(doc.customer_address, T, 10, M.x + leftW - custX) : []),
      ...(doc.customer_phone ? para('Telp : ' + doc.customer_phone, T, 10, M.x + leftW - custX) : []),
    ];
    text('Customer', M.x, ly, { font: T });
    text(':', custX - 10, ly, { font: T });
    ly += draw(cust, custX, ly);

    const sp = 5;
    const title = 'INVOICE';
    const titleW = width(title, TB, 17) + sp * (title.length - 1);
    let tx = M.x + leftW + (W - leftW - metaW - titleW) / 2;
    for (const ch of title) { text(ch, tx, y, { font: TB, size: 17 }); tx += width(ch, TB, 17) + sp; }

    const meta = [['Number', doc.number], ['Inv. Date', tglIndo(doc.issue_date)], ['Payment Term', paymentTerm(doc)],
      ['Due Date', tglIndo(doc.date2)], ['Currency', 'IDR']];
    if (doc.status === 'paid') meta.push(['Status', 'LUNAS']);
    let my = y;
    for (const [k, v] of meta) {
      text(k, metaX, my, { font: T });
      text(':', metaX + 68, my, { font: T });
      my += draw(para(v, k === 'Status' ? TB : T, 10, metaW - 76), metaX + 76, my);
    }
    y = Math.max(ly, my) + 7 * MM;

    // ---- tabel barang ----
    let cx = M.x;
    const cols = [['No.', 5, 'center'], ['Product Description', 27, 'left'], ['Qty', 7, 'center'], ['UOM', 7, 'center'], ['Unit Price', 13, 'right'],
      ['Gross Amt.', 13, 'right'], ['%', 5, 'center'], ['Amount', 10, 'right'], ['Net Amount', 13, 'right']].map(([t, p, a]) => {
      const col = { t, a, x: cx, w: (p / 100) * W };
      cx += col.w;
      return col;
    });
    const PX = 2.5;
    const HEAD_H = 32;
    const cell = (t, k, top) => {
      let size = 9;
      while (size > 5.5 && width(clean(t), T, size) > k.w - PX * 2 + 1) size -= 0.25;
      text(t, k.x + PX, top, { font: T, size, align: k.a, w: k.w - PX * 2 });
    };
    function head() {
      dashed(M.x, M.x + W, y);
      cols.forEach((k, i) => cell(k.t, k, y + (i === 6 || i === 7 ? 19 : 11)));
      const gx = cols[6].x;
      const gw = cols[6].w + cols[7].w;
      text('Discount Detail', gx, y + 3, { font: T, size: 9, align: 'center', w: gw });
      dashed(gx, gx + gw, y + 16);
      dashed(M.x, M.x + W, y + HEAD_H);
      y += HEAD_H + 2;
    }
    ensure(HEAD_H + 30);
    head();
    doc.items.forEach((it, n) => {
      const dw = cols[1].w - PX * 2;
      let rest = [...para(it.description, T, 9, dw), ...(it.details ? para(it.details, T, 8, dw).map((l) => ({ ...l, color: gray(0.2) })) : [])];
      const rowH = heightOf(rest) + 5;
      if (rowH > room() && rowH <= PAGE.h - M.top - M.bottom - HEAD_H - 2) { dashed(M.x, M.x + W, y); newPage(); head(); }
      let first = true;
      while (rest.length) {
        let take = 0;
        let h = 5;
        while (take < rest.length && h + lh(rest[take].size) <= room()) { h += lh(rest[take].size); take++; }
        if (!take) { dashed(M.x, M.x + W, y); newPage(); head(); continue; }
        draw(rest.slice(0, take), cols[1].x + PX, y + 2);
        if (first) {
          const gross = num(it.qty) * num(it.unit_price);
          [String(n + 1), null, qtyFmt(it.qty), it.unit || '', rupiah(it.unit_price), rupiah(gross), `${qtyFmt(it.discount_percent)}%`,
            rupiah(gross - num(it.line_total)), rupiah(it.line_total)].forEach((v, i) => { if (v !== null) cell(v, cols[i], y + 2); });
          first = false;
        }
        y += h;
        rest = rest.slice(take);
      }
    });
    dashed(M.x, M.x + W, y);
    y += 5;

    // ---- terbilang & rekening | tanda tangan | total (satu blok) ----
    const aW = 60 * MM;
    const cW = 54 * MM;
    const bX = M.x + aW + 3 * MM;
    const cX = M.x + W - cW;
    const bW = cX - 3 * MM - bX;
    const total = num(doc.total);
    const wordX = 38;
    const words = para(inWords(total), T, 10, aW - wordX);
    const terms = invoiceTerms(doc, s);
    const remark = [
      ...(doc.notes ? para(doc.notes, T, 10, aW) : []),
      ...(terms.length ? para('Syarat & Ketentuan :', T, 9, aW) : []),
      ...terms.flatMap((t, i) => para(t, T, 9, aW - 14).map((l, j) => ({ ...l, indent: 14, num: j ? '' : `${i + 1}.` }))),
    ];
    const bank = [
      ...(s.bank_name ? para(s.bank_name, T, 10, aW) : []),
      ...(s.bank_account_no ? para('A/C : ' + s.bank_account_no, T, 10, aW) : []),
      ...(s.bank_account_holder ? para('A/N : ' + s.bank_account_holder, T, 10, aW) : []),
    ];
    const signer = para(s.signer_name || s.company_name, TB, 10, bW);
    const STAMP_H = 34 * MM;
    const footH = 10 * MM + lh(8.5);
    const aH = heightOf(words) + 11 + lh(10) + heightOf(remark) + 17 + (bank.length ? lh(10) + heightOf(bank) : 0);
    const bH = lh(10) + STAMP_H + heightOf(signer);
    // catatan yang sangat panjang ditulis terpisah supaya tidak keluar halaman
    const longRemark = Math.max(aH, bH) + footH > PAGE.h - M.top - M.bottom;
    if (longRemark) { ensure(lh(10) * 2); text('Remark :', M.x, y, { font: T }); y += lh(10); for (const l of remark) { ensure(lh(l.size)); y += draw([l], M.x, y); } y += 6; }
    ensure(Math.max(longRemark ? 0 : aH, bH) + footH);
    const top = y;

    let ay = top;
    text('Inword :', M.x, ay, { font: T });
    ay += draw(words, M.x + wordX, ay) + 11;
    if (!longRemark) {
      text('Remark :', M.x, ay, { font: T });
      ay += lh(10);
      ay += draw(remark, M.x, ay) + 17;
    }
    if (bank.length) {
      text('TRANSFER VIA', M.x, ay, { font: T });
      hline(M.x, M.x + width('TRANSFER VIA', T, 10), ay + 11, 0.6, black);
      ay += lh(10);
      ay += draw(bank, M.x, ay);
    }

    text('Sincerely,', bX, top, { font: T, align: 'center', w: bW });
    // materai dan QR berdampingan dengan jarak, supaya QR tetap mudah dipindai
    const stampTop = top + lh(10) + 3 * MM;
    const side = 26 * MM;
    const mtW = total >= MATERAI_MIN ? 22 * MM : 0;
    const qrW = qrUrl ? side : 0;
    const gap = mtW && qrW ? 7 * MM : 0;
    let sx = bX + (bW - mtW - gap - qrW) / 2;
    if (mtW) {
      box(sx, stampTop, mtW, side, { borderColor: black, borderWidth: 0.8 });
      text('Materai', sx, stampTop + side / 2 - 11, { font: T, size: 8, align: 'center', w: mtW });
      text('Rp10.000', sx, stampTop + side / 2 + 1, { font: T, size: 8, align: 'center', w: mtW });
      sx += mtW + gap;
    }
    if (qrUrl) drawQr(sx, stampTop, sx - 3 * MM, side + 6 * MM);
    let ny = top + lh(10) + STAMP_H;
    for (const l of signer) {
      text(l.t, bX, ny, { font: TB, align: 'center', w: bW });
      const tw = width(l.t, TB, 10);
      hline(bX + (bW - tw) / 2, bX + (bW + tw) / 2, ny + 11, 0.7, black);
      ny += lh(10);
    }

    let ry = top;
    const amount = (k, v, font = T) => {
      // angka sangat besar: label digeser ke kiri, huruf diperkecil bila masih tidak muat
      let size = 10;
      while (size > 6 && width(k, font, size) + width(v, font, size) + 8 > cW) size -= 0.25;
      const labelEnd = Math.min(cX + cW * 0.56, M.x + W - 2 - width(v, font, size) - 6);
      text(k, cX, ry, { font, size, align: 'right', w: labelEnd - cX });
      text(v, cX, ry, { font, size, align: 'right', w: cW - 2 });
      ry += 15;
    };
    amount('Gross Total', rupiah(doc.subtotal));
    amount('Discount Total', rupiah(doc.discount_total));
    amount(`Tax (PPN ${qtyFmt(doc.tax_percent)}%)`, rupiah(doc.tax_amount));
    dashed(cX, M.x + W, ry);
    ry += 3;
    amount('Net Total', rupiah(total), TB);
    hline(cX, M.x + W, ry, 0.7, black);
    hline(cX, M.x + W, ry + 2, 0.7, black);

    y = Math.max(ay, ny, ry) + 10 * MM;
    ensure(lh(8.5));
    text(FOOT_NOTE, M.x, y, { font: T, size: 8.5, align: 'center', w: W });
  }

  // ---- kop ----
  const logo = await embedLogo(pdf, s.logo_data);
  let lw = 0;
  let lhgt = 0;
  if (logo) {
    const k = Math.min((42 * MM) / logo.width, (24 * MM) / logo.height, 1);
    lw = logo.width * k;
    lhgt = logo.height * k;
  }
  const kx = M.x + (logo ? lw + 12 : 0);
  const kw = M.x + W - kx;
  const contact = [s.phone ? 'Telp. ' + s.phone : '', s.email].filter(Boolean).join('  |  ');
  const nameLines = wrap(s.company_name, B, 15, kw);
  const kopLines = [s.address ? wrap(s.address, R, 9, kw) : [], contact ? wrap(contact, R, 9, kw) : []].flat();
  const textH = nameLines.length * lh(15) + kopLines.length * lh(9);
  const kopH = Math.max(textH, lhgt);
  if (logo) page.drawImage(logo, { x: M.x, y: PAGE.h - y - (kopH + lhgt) / 2, width: lw, height: lhgt });
  let ty = y + (kopH - textH) / 2;
  ty += lines(nameLines, kx, ty, { font: B, size: 15 });
  lines(kopLines, kx, ty, { size: 9, color: SOFT });
  y += kopH + 8;
  hline(M.x, M.x + W, y, 2);
  y += 14;

  // ---- judul ----
  const title = c.title;
  const sp = 2.4; // jarak antarhuruf
  const titleW = width(title, B, 14) + sp * (title.length - 1);
  let tx = M.x + (W - titleW) / 2;
  for (const ch of title) { text(ch, tx, y, { font: B, size: 14 }); tx += width(ch, B, 14) + sp; }
  y += 30;

  // ---- penerima & data dokumen ----
  const metaRows = [['Nomor', doc.number, B], ['Tanggal', tglIndo(doc.issue_date), R]];
  if (doc.date2) metaRows.push([c.date2Label, tglIndo(doc.date2), R]);
  const labW = Math.max(...metaRows.map((r) => width(r[0], R, 10))) + 6;
  const valW = Math.min(150, Math.max(...metaRows.map((r) => width(clean(r[1]), r[2], 10))));
  const metaX = M.x + W - (labW + 9 + valW);
  const toW = metaX - M.x - 16;
  let ly = y;
  label('Kepada Yth.', M.x, ly); ly += 12;
  ly += lines(wrap(doc.customer_name, B, 11, toW), M.x, ly, { font: B, size: 11 });
  if (doc.customer_address) ly += lines(wrap(doc.customer_address, R, 10, toW), M.x, ly);
  if (doc.customer_phone) ly += lines(wrap('Telp. ' + doc.customer_phone, R, 10, toW), M.x, ly);
  let my = y;
  for (const [k, v, font] of metaRows) {
    text(k, metaX, my);
    text(':', metaX + labW, my);
    my += lines(wrap(v, font, 10, valW + 0.5), metaX + labW + 9, my, { font });
  }
  y = Math.max(ly, my) + 10;

  if (doc.subject) {
    const head = 'Perihal : ';
    const hw = width(head, B, 10);
    ensure(lh(10));
    text(head, M.x, y, { font: B });
    flow(wrap(doc.subject, R, 10, W - hw), M.x + hw, { size: 10 });
    y += 4;
  }
  flow(['Dengan hormat,', ...wrap('Berikut kami sampaikan penawaran harga dengan rincian sebagai berikut:', R, 10, W)], M.x, { size: 10 });
  y += 8;

  // ---- tabel barang ----
  const showDisc = doc.items.some((i) => num(i.discount_percent) > 0);
  const cols = [
    { t: 'NO', p: 0.07, a: 'center' }, { t: 'NAMA BARANG', p: 0, a: 'left' }, { t: 'QTY', p: 0.11, a: 'center' },
    { t: 'HARGA (RP)', p: 0.16, a: 'right' }, ...(showDisc ? [{ t: 'DISC', p: 0.09, a: 'center' }] : []),
    { t: 'TOTAL (RP)', p: 0.17, a: 'right' },
  ];
  cols[1].p = 1 - cols.reduce((a, k) => a + k.p, 0);
  let cx = M.x;
  for (const col of cols) { col.x = cx; col.w = col.p * W; cx += col.w; }
  const PX = 5;
  const PY = 4.5;
  const HEAD_H = 19;

  const grid = (top, h) => [...cols.map((k) => k.x), M.x + W].forEach((x) => vline(x, top, top + h));
  function tableHead() {
    box(M.x, y, W, HEAD_H, { color: FILL });
    hline(M.x, M.x + W, y); hline(M.x, M.x + W, y + HEAD_H);
    grid(y, HEAD_H);
    for (const k of cols) text(k.t, k.x + PX, y + 5.5, { font: B, size: 8.5, align: k.a === 'left' ? 'left' : k.a, w: k.w - PX * 2 });
    y += HEAD_H;
  }
  /** Angka/teks pendek: perkecil huruf bila tidak muat di kolom. */
  const cell = (t, k, top) => {
    let size = 9.5;
    while (size > 6 && width(clean(t), R, size) > k.w - PX * 2 + 2) size -= 0.25;
    text(t, k.x + PX, top, { size, align: k.a, w: k.w - PX * 2 });
  };

  ensure(HEAD_H + 40);
  tableHead();
  doc.items.forEach((it, n) => {
    const nw = cols[1].w - PX * 2;
    let rest = [
      ...wrap(it.description, B, 10, nw).map((t) => ({ t, font: B, size: 10, color: BLACK })),
      ...(it.details ? wrap(it.details, R, 9, nw).map((t) => ({ t, font: R, size: 9, color: SOFT })) : []),
    ];
    const rowH = (arr) => arr.reduce((a, l) => a + lh(l.size), 0) + PY * 2;
    const pageRoom = PAGE.h - M.top - M.bottom - HEAD_H;
    // baris tidak dipotong, kecuali memang lebih tinggi dari satu halaman
    if (rowH(rest) > room() && rowH(rest) <= pageRoom) { hline(M.x, M.x + W, y); newPage(); tableHead(); }
    let first = true;
    while (rest.length) {
      let take = 0;
      let h = PY * 2;
      while (take < rest.length && h + lh(rest[take].size) <= room()) { h += lh(rest[take].size); take++; }
      if (!take) { hline(M.x, M.x + W, y); newPage(); tableHead(); continue; }
      let iy = y + PY;
      for (const l of rest.slice(0, take)) { text(l.t, cols[1].x + PX, iy, l); iy += lh(l.size); }
      if (first) {
        const top = y + PY + 0.5;
        const vals = [String(n + 1), null, `${qtyFmt(it.qty)}${it.unit ? ' ' + it.unit : ''}`, rupiah(it.unit_price),
          ...(showDisc ? [num(it.discount_percent) > 0 ? `${qtyFmt(it.discount_percent)}%` : '-'] : []), rupiah(it.line_total)];
        vals.forEach((v, i) => { if (v !== null) cell(v, cols[i], top); });
        first = false;
      }
      grid(y, h);
      y += h;
      rest = rest.slice(take);
      const end = !rest.length && n === doc.items.length - 1;
      hline(M.x, M.x + W, y, end ? 1.1 : 0.6, end ? BLACK : LINE);
    }
  });
  y += 10;

  // ---- terbilang & total ----
  const total = num(doc.total);
  const totW = 66 * MM;
  const totX = M.x + W - totW;
  const sumRows = [];
  if (num(doc.discount_total) > 0 || num(doc.tax_amount) > 0) sumRows.push(['Subtotal', rupiah(doc.subtotal)]);
  if (num(doc.discount_total) > 0) sumRows.push(['Diskon', '- ' + rupiah(doc.discount_total)]);
  if (num(doc.tax_amount) > 0) sumRows.push([`PPN ${qtyFmt(doc.tax_percent)}%`, rupiah(doc.tax_amount)]);
  const words = terbilang(total);
  const boxW = totX - M.x - 14;
  const wordLines = wrap(`${words.charAt(0).toUpperCase()}${words.slice(1)} rupiah`, I, 9.5, boxW - 16);
  const boxH = 22 + wordLines.length * lh(9.5);
  ensure(Math.max(boxH, sumRows.length * 16 + 20));
  box(M.x, y, boxW, boxH, { borderColor: LINE, borderWidth: 0.8 });
  label('Terbilang', M.x + 8, y + 5);
  lines(wordLines, M.x + 8, y + 17, { font: I, size: 9.5 });
  let sy = y;
  for (const [k, v] of sumRows) {
    text(k, totX + 6, sy + 3);
    text(v, totX + 6, sy + 3, { align: 'right', w: totW - 12 });
    sy += 16;
  }
  box(totX, sy, totW, 20, { color: FILL });
  hline(totX, totX + totW, sy, 1.2); hline(totX, totX + totW, sy + 20, 1.2);
  text('TOTAL', totX + 6, sy + 4.5, { font: B, size: 11 });
  text('Rp ' + rupiah(total), totX + 6, sy + 4.5, { font: B, size: 11, align: 'right', w: totW - 12 });
  y = Math.max(y + boxH, sy + 20) + 14;

  // ---- catatan ----
  if (doc.notes) {
    ensure(12 + lh(9.5));
    label('Catatan', M.x, y); y += 12;
    flow(wrap(doc.notes, R, 9.5, W), M.x, { size: 9.5 });
    y += 6;
  }

  // ---- rekening & syarat ----
  const terms = String(doc.terms || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const hasBank = s.bank_name || s.bank_account_no || s.bank_account_holder;
  if (hasBank || terms.length) {
    const gap = 18;
    const colW = hasBank && terms.length ? (W - gap) / 2 : W;
    const bank = hasBank ? [
      ...(s.bank_name ? wrap(s.bank_name, R, 9.5, colW).map((t) => ({ t, size: 9.5 })) : []),
      ...(s.bank_account_no ? wrap(s.bank_account_no, B, 11, colW).map((t) => ({ t, size: 11, font: B })) : []),
      ...(s.bank_account_holder ? wrap('a.n. ' + s.bank_account_holder, R, 9.5, colW).map((t) => ({ t, size: 9.5 })) : []),
    ] : [];
    const list = terms.flatMap((t, i) => wrap(t, R, 8.8, colW - 14).map((l, j) => ({ t: l, size: 8.8, num: j ? '' : `${i + 1}.` })));
    const hOf = (arr) => (arr.length ? 12 + arr.reduce((a, l) => a + lh(l.size), 0) : 0);
    const need = Math.max(hOf(bank), hOf(list));
    const fits = need <= PAGE.h - M.top - M.bottom;
    if (fits) ensure(need);
    const top = y;
    let by = top;
    if (bank.length) {
      label('Pembayaran via transfer', M.x, by); by += 12;
      for (const l of bank) { text(l.t, M.x, by, l); by += lh(l.size); }
    }
    const rx = hasBank ? M.x + colW + gap : M.x;
    if (list.length) {
      if (!fits) { y = by + 8; ensure(30); }
      let ry = fits ? top : y;
      const x = fits ? rx : M.x;
      label('Syarat & Ketentuan', x, ry); ry += 12;
      for (const l of list) {
        if (!fits && ry + lh(l.size) > PAGE.h - M.bottom) { newPage(); ry = y; }
        text(l.num, x, ry, l); text(l.t, x + 14, ry, l); ry += lh(l.size);
      }
      y = Math.max(fits ? by : 0, ry);
    } else y = by;
    y += 10;
  }

  // ---- penutup & tanda tangan (selalu satu halaman) ----
  const thanks = wrap(`Demikian surat penawaran ini kami sampaikan. Atas perhatian dan kerja samanya, kami ucapkan terima kasih.`, R, 9.5, W);
  const signW = 62 * MM;
  const signer = s.signer_name || s.company_name;
  const left = [{ t: 'Disetujui oleh,' }];
  const right = [
    ...wrap(`${s.city ? s.city + ', ' : ''}${tglIndo(doc.issue_date)}`, R, 9.5, signW).map((t) => ({ t })), { t: 'Hormat kami,' },
  ];
  const leftName = wrap(`( ${doc.customer_name} )`, B, 9.5, signW);
  const rightName = wrap(`( ${signer} )`, B, 9.5, signW);
  const space = qrUrl ? 36 * MM : 28 * MM;
  const headH = Math.max(left.length, right.length) * lh(9.5);
  const nameH = Math.max(leftName.length, rightName.length) * lh(9.5) + 4;
  ensure(thanks.length * lh(9.5) + 8 + headH + space + nameH);
  y += lines(thanks, M.x, y, { size: 9.5 }) + 8;
  const rightX = M.x + W - signW;
  const center = { size: 9.5, align: 'center', w: signW };
  left.forEach((l, i) => text(l.t, M.x, y + i * lh(9.5), center));
  right.forEach((l, i) => text(l.t, rightX, y + i * lh(9.5), center));
  const nameY = y + headH + space;
  hline(M.x, M.x + signW, nameY); hline(rightX, M.x + W, nameY);
  lines(leftName, M.x, nameY + 4, { ...center, font: B });
  lines(rightName, rightX, nameY + 4, { ...center, font: B });

  if (qrUrl) drawQr(rightX + (signW - 26 * MM) / 2, nameY - 26 * MM - 12, rightX, signW);

  numberPages();
  return pdf.save();
}

/** Contoh: "Penawaran QT-2026-0001 - PT Maju Jaya.pdf" */
export function pdfFileName(type, doc) {
  const safe = (v) => String(v || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  const who = safe(doc.customer_name).slice(0, 60).replace(/[ .-]+$/, '');
  return `${api.TYPES[type].label} ${safe(doc.number)}${who ? ' - ' + who : ''}.pdf`;
}

function saveFile(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Dipanggil tombol "Download PDF": ambil data terbaru, buat PDF, lalu unduh. */
export async function downloadPdf(type, id, btn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Menyiapkan...'; }
  try {
    const [doc, s] = await Promise.all([api.getDoc(type, id), api.getSettings()]);
    if (!doc) throw new Error('Dokumen tidak ditemukan');
    const qrUrl = doc.verify_token ? verifyUrl(type, doc.verify_token) : '';
    const bytes = await buildPdf({ doc, s, type, qrUrl });
    const name = pdfFileName(type, doc);
    saveFile(bytes, name);
    toast('PDF diunduh: ' + name);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
