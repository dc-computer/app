// Lembar dokumen (penawaran/invoice) — dipakai oleh halaman cetak dan halaman verifikasi QR.
import { qrSvg } from './qr.js';
import { TYPES } from './api.js';
import { getCfg } from './supabase.js';
import { esc, nl2br, rupiah, qtyFmt, tglIndo, terbilang, num } from './util.js';

/** Tautan verifikasi untuk QR. Menyertakan alamat project + kunci publik supaya bisa dibuka di HP mana pun
 *  (kunci publishable memang publik). Jika terlalu panjang untuk QR, parameter dilewati. */
export function verifyUrl(type, token) {
  const base = `${location.origin}${location.pathname}#/v/${type}/${token}`;
  const { url, key } = getCfg();
  if (!url || !key) return base;
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(url);
  const full = `${base}?u=${m ? m[1] : encodeURIComponent(url)}&k=${encodeURIComponent(key)}`;
  return new TextEncoder().encode(full).length <= 210 ? full : base;
}

/** Kotak materai ditampilkan pada invoice dengan total mulai nilai ini. */
export const MATERAI_MIN = 5000000;
export const FOOT_NOTE = 'PEMBAYARAN DENGAN CHEQUE/BG DIANGGAP LUNAS, APABILA SUDAH DAPAT DIUANGKAN';

/** "Cash/Tunai" atau "14 Hari", dihitung dari tanggal invoice dan jatuh tempo. */
export function paymentTerm(doc) {
  if (!doc.date2) return '-';
  const days = Math.round((Date.parse(doc.date2) - Date.parse(doc.issue_date)) / 86400000);
  return days > 0 ? `${days} Hari` : 'Cash/Tunai';
}

export const inWords = (total) => `${terbilang(total)} rupiah`.replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Syarat & ketentuan untuk Remark invoice: dari dokumen, atau dari Pengaturan bila dokumen kosong. */
export const invoiceTerms = (doc, s) =>
  String(doc.terms || s.terms || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

/** Lembar invoice. */
function invoiceHtml({ doc, s, qrUrl }) {
  const total = num(doc.total);
  const hasBank = s.bank_name || s.bank_account_no || s.bank_account_holder;
  const terms = invoiceTerms(doc, s);
  const row = (k, v) => `<tr><td>${k}</td><td>:</td><td>${v}</td></tr>`;
  const sum = (k, v) => `<tr><td class="r">${k}</td><td class="r">${v}</td></tr>`;
  return `<div class="sheet-scroll"><div class="sheet inv">
    <div class="inv-top">
      <div>
        <div class="inv-co">
          ${s.logo_data ? `<img class="logo" src="${s.logo_data}" alt="">` : ''}
          <div><b>${esc(s.company_name)}</b>
            ${s.address ? `<div>${nl2br(s.address)}</div>` : ''}
            ${s.phone ? `<div>Telp : ${esc(s.phone)}</div>` : ''}
            ${s.email ? `<div>Email : ${esc(s.email)}</div>` : ''}</div>
        </div>
        <div class="inv-cust"><div>Customer</div><div>:</div><div><b>${esc(doc.customer_name)}</b>
          ${doc.customer_address ? `<div>${nl2br(doc.customer_address)}</div>` : ''}
          ${doc.customer_phone ? `<div>Telp : ${esc(doc.customer_phone)}</div>` : ''}</div></div>
      </div>
      <h1>INVOICE</h1>
      <table class="inv-meta">
        ${row('Number', esc(doc.number))}
        ${row('Inv. Date', tglIndo(doc.issue_date))}
        ${row('Payment Term', paymentTerm(doc))}
        ${row('Due Date', tglIndo(doc.date2))}
        ${row('Currency', 'IDR')}
        ${doc.status === 'paid' ? row('Status', '<b>LUNAS</b>') : ''}
      </table>
    </div>

    <table class="inv-items">
      <colgroup>${[5, 27, 7, 7, 13, 13, 5, 10, 13].map((w) => `<col style="width:${w}%">`).join('')}</colgroup>
      <thead>
        <tr><th rowspan="2">No.</th><th rowspan="2" class="l">Product Description</th><th rowspan="2">Qty</th><th rowspan="2">UOM</th>
          <th rowspan="2" class="r">Unit Price</th><th rowspan="2" class="r">Gross Amt.</th><th colspan="2" class="grp">Discount Detail</th><th rowspan="2" class="r">Net Amount</th></tr>
        <tr><th>%</th><th class="r">Amount</th></tr>
      </thead>
      <tbody>
      ${doc.items.map((it, n) => {
        const gross = num(it.qty) * num(it.unit_price);
        return `<tr><td class="c">${n + 1}</td>
        <td>${esc(it.description)}${it.details ? `<div class="inv-spec">${nl2br(it.details)}</div>` : ''}</td>
        <td class="c">${qtyFmt(it.qty)}</td><td class="c">${esc(it.unit)}</td>
        <td class="r">${rupiah(it.unit_price)}</td><td class="r">${rupiah(gross)}</td>
        <td class="c">${qtyFmt(it.discount_percent)}%</td><td class="r">${rupiah(gross - num(it.line_total))}</td>
        <td class="r">${rupiah(it.line_total)}</td></tr>`;
      }).join('')}
      </tbody>
    </table>

    <div class="inv-bottom">
      <div>
        <div class="inv-words"><span>Inword :</span><span>${esc(inWords(total))}</span></div>
        <div class="inv-remark">Remark : ${doc.notes ? `<div>${nl2br(doc.notes)}</div>` : ''}
          ${terms.length ? `<div class="inv-terms">Syarat &amp; Ketentuan :<ol>${terms.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}</div>
        ${hasBank ? `<div><u>TRANSFER VIA</u>
          <div>${esc(s.bank_name)}</div>
          ${s.bank_account_no ? `<div>A/C : ${esc(s.bank_account_no)}</div>` : ''}
          ${s.bank_account_holder ? `<div>A/N : ${esc(s.bank_account_holder)}</div>` : ''}</div>` : ''}
      </div>
      <div class="inv-sign">
        <div>Sincerely,</div>
        <div class="inv-stamps">
          ${total >= MATERAI_MIN ? '<div class="materai">Materai<br>Rp10.000</div>' : ''}
          ${qrUrl ? `<div class="qr-wrap"><div class="qr">${qrSvg(qrUrl)}</div><div class="qr-cap">Cap Digital &middot; scan untuk verifikasi</div></div>` : ''}
        </div>
        <div class="inv-signer">${esc(s.signer_name || s.company_name)}</div>
      </div>
      <table class="inv-totals">
        ${sum('Gross Total', rupiah(doc.subtotal))}
        ${sum('Discount Total', rupiah(doc.discount_total))}
        ${sum(`Tax (PPN ${qtyFmt(doc.tax_percent)}%)`, rupiah(doc.tax_amount))}
        <tr class="net"><td class="r">Net Total</td><td class="r">${rupiah(total)}</td></tr>
      </table>
    </div>
    <div class="inv-foot">${FOOT_NOTE}</div>
  </div></div>`;
}

/** HTML lembar A4. qrUrl kosong -> tanpa QR. */
export function sheetHtml({ doc, s, type, qrUrl }) {
  if (type === 'invoice') return invoiceHtml({ doc, s, qrUrl });
  const c = TYPES[type];
  const showDisc = doc.items.some((i) => num(i.discount_percent) > 0);
  const terms = String(doc.terms || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const hasBank = s.bank_name || s.bank_account_no || s.bank_account_holder;
  const signer = s.signer_name || s.company_name;
  const total = num(doc.total);
  const contact = [s.phone ? 'Telp. ' + s.phone : '', s.email].filter(Boolean).join('  |  ');
  return `<div class="sheet-scroll"><div class="sheet">
    <header class="kop">
      ${s.logo_data ? `<img class="logo" src="${s.logo_data}" alt="">` : ''}
      <div class="kop-text">
        <div class="company">${esc(s.company_name)}</div>
        ${s.address ? `<div>${nl2br(s.address)}</div>` : ''}
        ${contact ? `<div>${esc(contact)}</div>` : ''}
      </div>
    </header>

    <h1 class="doc-title">${c.title}</h1>

    <section class="info">
      <div class="to">
        <div class="lbl">Kepada Yth.</div>
        <div class="to-name">${esc(doc.customer_name)}</div>
        ${doc.customer_address ? `<div>${nl2br(doc.customer_address)}</div>` : ''}
        ${doc.customer_phone ? `<div>Telp. ${esc(doc.customer_phone)}</div>` : ''}
      </div>
      <table class="meta">
        <tr><td>Nomor</td><td>:</td><td><b>${esc(doc.number)}</b></td></tr>
        <tr><td>Tanggal</td><td>:</td><td>${tglIndo(doc.issue_date)}</td></tr>
        ${doc.date2 ? `<tr><td>${c.date2Label}</td><td>:</td><td>${tglIndo(doc.date2)}</td></tr>` : ''}
      </table>
    </section>

    ${doc.subject ? `<p class="subject"><b>Perihal :</b> ${esc(doc.subject)}</p>` : ''}
    <p class="intro">Dengan hormat,<br>Berikut kami sampaikan penawaran harga dengan rincian sebagai berikut:</p>

    <table class="items">
      <thead><tr>
        <th class="c" style="width:7%">No</th><th>Nama Barang</th><th class="c" style="width:11%">Qty</th>
        <th class="r" style="width:16%">Harga (Rp)</th>${showDisc ? '<th class="c" style="width:9%">Disc</th>' : ''}
        <th class="r" style="width:17%">Total (Rp)</th></tr></thead>
      <tbody>
      ${doc.items.map((it, n) => `<tr>
        <td class="c">${n + 1}</td>
        <td><div class="it-name">${esc(it.description)}</div>${it.details ? `<div class="it-spec">${nl2br(it.details)}</div>` : ''}</td>
        <td class="c">${qtyFmt(it.qty)}${it.unit ? ' ' + esc(it.unit) : ''}</td>
        <td class="r">${rupiah(it.unit_price)}</td>
        ${showDisc ? `<td class="c">${num(it.discount_percent) > 0 ? qtyFmt(it.discount_percent) + '%' : '-'}</td>` : ''}
        <td class="r">${rupiah(it.line_total)}</td></tr>`).join('')}
      </tbody>
    </table>

    <div class="summary">
      <div class="terbilang"><div class="lbl">Terbilang</div><em>${esc((t => t.charAt(0).toUpperCase() + t.slice(1))(terbilang(total)))} rupiah</em></div>
      <table class="totals">
        ${num(doc.discount_total) > 0 || num(doc.tax_amount) > 0 ? `<tr><td>Subtotal</td><td class="r">${rupiah(doc.subtotal)}</td></tr>` : ''}
        ${num(doc.discount_total) > 0 ? `<tr><td>Diskon</td><td class="r">- ${rupiah(doc.discount_total)}</td></tr>` : ''}
        ${num(doc.tax_amount) > 0 ? `<tr><td>PPN ${qtyFmt(doc.tax_percent)}%</td><td class="r">${rupiah(doc.tax_amount)}</td></tr>` : ''}
        <tr class="grand"><td>TOTAL</td><td class="r">Rp ${rupiah(total)}</td></tr>
      </table>
    </div>

    <div class="closing">
      ${doc.notes ? `<div class="block"><div class="lbl">Catatan</div><div>${nl2br(doc.notes)}</div></div>` : ''}
      <div class="two">
        ${hasBank ? `<div class="block"><div class="lbl">Pembayaran via transfer</div>
          <div>${esc(s.bank_name)}</div><div class="rek">${esc(s.bank_account_no)}</div>
          <div>${s.bank_account_holder ? 'a.n. ' + esc(s.bank_account_holder) : ''}</div></div>` : ''}
        ${terms.length ? `<div class="block"><div class="lbl">Syarat &amp; Ketentuan</div>
          <ol class="terms">${terms.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}
      </div>
      <p class="thanks">Demikian surat penawaran ini kami sampaikan. Atas perhatian dan kerja samanya, kami ucapkan terima kasih.</p>
      <div class="sign">
        <div class="sign-box"><div>Disetujui oleh,</div><div class="sign-space"></div>
          <div class="sign-name">( ${esc(doc.customer_name)} )</div></div>
        <div class="sign-box"><div>${esc(s.city)}, ${tglIndo(doc.issue_date)}<br>Hormat kami,</div><div class="sign-space">${qrUrl ? `<div class="qr-wrap"><div class="qr">${qrSvg(qrUrl)}</div><div class="qr-cap">Cap Digital &middot; scan untuk verifikasi</div></div>` : ''}</div>
          <div class="sign-name">( ${esc(signer)} )</div></div>
      </div>
    </div>
  </div></div>`;
}
