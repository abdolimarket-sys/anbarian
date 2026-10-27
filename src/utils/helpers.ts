/** ابزارهای عمومی */

export function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function dateStr(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function generateId(prefix = ''): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}

export function formatFaNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('fa-IR');
}

export function formatAuditTime(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString('fa-IR') +
      ' ' +
      d.toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  } catch {
    return iso;
  }
}

export function downloadFile(
  content: string | Blob,
  filename: string,
  mime = 'text/plain;charset=utf-8'
): void {
  const blob =
    typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
