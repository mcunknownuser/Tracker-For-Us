// =============================================================================
//  statements.ts
//  Per-person earnings statements: types, the month-range helper, a CSV
//  serializer, and a PDF generator (downloads a real .pdf — no print dialog).
//  Department pages build the Statement[] (they know their own earnings
//  model); this file turns those into a CSV or branded PDF.
// =============================================================================
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { shiftMonthKey, monthLongLabel } from './ofm';

export type StatementLine = { date?: string; label: string; amountCents: number };
export type StatementSection = { title: string; items: StatementLine[] };

export type Statement = {
  memberName: string;
  roleLabel: string;
  basisLine: string; // e.g. "$920.00 withdrawals × 50% share"
  earnedCents: number;
  paidCents: number;
  owedCents: number;
  sections: StatementSection[];
};

// Inclusive list of YYYY-MM month keys between two months (order-agnostic).
export function monthsInRange(from: string, to: string): string[] {
  let a = from;
  let b = to;
  if (a > b) [a, b] = [b, a];
  const out: string[] = [];
  let cur = a;
  while (cur <= b && out.length <= 60) {
    out.push(cur);
    cur = shiftMonthKey(cur, 1);
  }
  return out;
}

export function periodLabel(from: string, to: string): string {
  return from === to ? monthLongLabel(from) : `${monthLongLabel(from)} – ${monthLongLabel(to)}`;
}

const money = (c: number) => (c / 100).toFixed(2);

function fmt(c: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m) return iso;
  return new Date(y, m - 1, d || 1).toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

// ---- CSV -------------------------------------------------------------------
export function statementsToCSV(statements: Statement[], agencyName: string, period: string): string {
  const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  lines.push([esc('Statement'), esc(agencyName)].join(','));
  lines.push([esc('Period'), esc(period)].join(','));
  lines.push('');
  lines.push(['Member', 'Role', 'Basis', 'Earned', 'Paid', 'Owed'].map(esc).join(','));
  for (const s of statements) {
    lines.push(
      [esc(s.memberName), esc(s.roleLabel), esc(s.basisLine), money(s.earnedCents), money(s.paidCents), money(s.owedCents)].join(','),
    );
  }
  return lines.join('\r\n');
}

export function downloadCSV(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- PDF (saved directly, one page per person) -----------------------------
type DocWithTable = jsPDF & { lastAutoTable: { finalY: number } };

export function savePDF(statements: Statement[], agencyName: string, period: string, filename: string): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' }) as DocWithTable;
  const W = doc.internal.pageSize.getWidth();
  const M = 48;

  statements.forEach((s, idx) => {
    if (idx > 0) doc.addPage();
    let y = 56;

    // Header band: agency (left) · period (right) + rule.
    doc.setFont('times', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(agencyName, M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(period.toUpperCase(), W - M, y, { align: 'right' });
    y += 10;
    doc.setDrawColor(20);
    doc.setLineWidth(1.5);
    doc.line(M, y, W - M, y);
    y += 32;

    // Person.
    doc.setFont('times', 'bold');
    doc.setFontSize(26);
    doc.setTextColor(20);
    doc.text(s.memberName, M, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(s.roleLabel.toUpperCase(), M, y);
    y += 18;

    // Totals: basis → earned, paid, owed.
    autoTable(doc, {
      startY: y,
      theme: 'plain',
      margin: { left: M, right: M },
      styles: { fontSize: 11, cellPadding: 4, textColor: 40 },
      columnStyles: { 1: { halign: 'right' } },
      body: [
        [s.basisLine, fmt(s.earnedCents)],
        ['Paid this period', '− ' + fmt(s.paidCents)],
      ],
    });
    const afterTotals = doc.lastAutoTable.finalY;
    doc.setDrawColor(20);
    doc.setLineWidth(1);
    doc.line(M, afterTotals + 6, W - M, afterTotals + 6);
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(20);
    doc.text('Balance owed', M, afterTotals + 26);
    doc.text(fmt(s.owedCents), W - M, afterTotals + 26, { align: 'right' });
    y = afterTotals + 46;

    // Line-item receipts.
    for (const sec of s.sections) {
      if (sec.items.length === 0) continue;
      autoTable(doc, {
        startY: y,
        margin: { left: M, right: M },
        head: [[sec.title.toUpperCase(), '', '']],
        body: sec.items.map((i) => [fmtDate(i.date), i.label, fmt(i.amountCents)]),
        theme: 'striped',
        headStyles: { fillColor: [245, 245, 245], textColor: 90, fontSize: 8, fontStyle: 'bold' },
        styles: { fontSize: 10, cellPadding: 4, textColor: 50 },
        columnStyles: { 0: { cellWidth: 70, textColor: 140 }, 2: { halign: 'right' } },
      });
      y = doc.lastAutoTable.finalY + 16;
    }
  });

  doc.save(filename);
}
