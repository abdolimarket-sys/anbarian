/**
 * Anbarin Barcode Scanner
 * Stable camera lifecycle, Html5Qrcode/ZXing decoding first, native BarcodeDetector fallback,
 * plus USB/Bluetooth keyboard-wedge and manual entry.
 *
 * Public API intentionally matches the previous module so application flows remain unchanged.
 */

import type { AppSettings } from '@/types';
import { toast } from './ui';
import { normalizeDigits } from '@/utils/helpers';

export type ScanSource = 'camera' | 'native' | 'html5' | 'bt' | 'manual';

export interface ScanResult {
  code: string;
  source: ScanSource;
  at: number;
}

export interface ScannerOptions {
  containerId: string;
  getSettings: () => AppSettings;
  canScan?: () => boolean;
  isQtyModalOpen?: () => boolean;
  onScan: (result: ScanResult) => void;
  onFieldFill?: (fieldId: string, code: string) => void;
}

type DetectorResult = { rawValue?: string };
type NativeDetector = {
  detect: (source: HTMLVideoElement) => Promise<DetectorResult[]>;
};

declare global {
  interface Window {
    Html5Qrcode?: any;
  }
}

let opts: ScannerOptions | null = null;
let active = false;
let quickMode = false;
let scanTargetField: string | null = null;
let generation = 0;

let html5Instance: any = null;
let html5Running = false;
let nativeStream: MediaStream | null = null;
let nativeVideo: HTMLVideoElement | null = null;
let nativeDetector: NativeDetector | null = null;
let nativeRaf = 0;
let nativeBusy = false;
let torchOn = false;

let lastScanTime = 0;
let lastScanCode = '';
const GLOBAL_COOLDOWN_MS = 260;
const SAME_CODE_COOLDOWN_MS = 1100;

let btBuffer = '';
let btTimer: ReturnType<typeof setTimeout> | null = null;
let btListenerAttached = false;
let audioCtx: AudioContext | null = null;
let scriptLoadPromise: Promise<boolean> | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();

const BARCODE_FORMAT_NAMES = [
  'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128',
  'CODE_39', 'ITF', 'CODABAR', 'QR_CODE', 'DATA_MATRIX',
  'PDF_417', 'AZTEC',
];

export function initScanner(options: ScannerOptions): void {
  opts = options;
  attachBluetoothListener();
}

export function isScannerActive(): boolean {
  return active;
}

export function openScanner(options?: {
  targetField?: string | null;
  quick?: boolean;
  title?: string;
}): void {
  if (!opts) {
    console.warn('[scanner] initScanner must be called before openScanner');
    return;
  }

  scanTargetField = options?.targetField ?? null;
  quickMode = !!options?.quick;
  active = true;
  generation++;

  const titleEl = document.getElementById('scannerTitle');
  if (titleEl && options?.title) titleEl.textContent = options.title;

  const modal = document.getElementById('scannerModal');
  if (modal) {
    modal.classList.add('show');
    // Keep compatibility with the app's existing modal implementation.
    modal.style.display = 'flex';
  }

  void startCamera(generation);
}

export function closeScanner(): void {
  active = false;
  generation++;
  scanTargetField = null;
  quickMode = false;
  void stopCamera();

  const modal = document.getElementById('scannerModal');
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = 'none';
  }
}

export function submitManualBarcode(raw?: string): void {
  const input = document.getElementById('manualBarcode') as HTMLInputElement | null;
  const code = normalizeDigits(raw ?? input?.value ?? '').trim();
  if (!code) {
    toast('بارکد را وارد کنید', 'error');
    return;
  }
  if (input) input.value = '';
  emitScan(code, 'manual');
}

export async function toggleTorch(): Promise<void> {
  const track = nativeStream?.getVideoTracks()[0];
  if (!track) {
    toast('نور در این حالت دوربین در دسترس نیست', 'info');
    return;
  }
  try {
    const capabilities = track.getCapabilities?.() as any;
    if (!capabilities?.torch) {
      toast('این دوربین از چراغ‌قوه پشتیبانی نمی‌کند', 'info');
      return;
    }
    const next = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: next }] } as any);
    torchOn = next;
    const button = document.getElementById('torchBtn');
    if (button) button.textContent = torchOn ? '🔦 خاموش' : '🔦 نور';
  } catch (error) {
    console.warn('[scanner] torch unavailable', error);
    toast('تغییر وضعیت چراغ‌قوه ممکن نشد', 'error');
  }
}

export function restartCamera(): void {
  if (!active) return;
  const token = ++generation;
  void (async () => {
    await stopCamera();
    await delay(180);
    if (active && token === generation) await startCamera(token);
  })();
}

export function playBeep(ok: boolean): void {
  if (!opts?.getSettings()?.soundOnScan) return;
  try {
    if (!audioCtx) {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) return;
      audioCtx = new AudioContextCtor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.frequency.value = ok ? 880 : 200;
    gain.gain.value = 0.12;
    oscillator.start();
    window.setTimeout(() => {
      try { oscillator.stop(); } catch { /* already stopped */ }
    }, ok ? 75 : 140);
  } catch {
    // Audio is optional; never interrupt scanning.
  }
}

export function vibrateOnFail(): void {
  if (opts?.getSettings()?.vibrateOnScan && navigator.vibrate) {
    navigator.vibrate([45, 25, 45]);
  }
}

export function markConfirmed(code: string): void {
  lastScanCode = normalizeDigits(code).trim();
  lastScanTime = Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isCurrent(token: number): boolean {
  return active && token === generation;
}

function shouldAcceptScan(code: string): boolean {
  const normalized = normalizeDigits(code).trim();
  if (!normalized) return false;
  const elapsed = Date.now() - lastScanTime;
  if (normalized === lastScanCode && elapsed < SAME_CODE_COOLDOWN_MS) return false;
  if (elapsed < GLOBAL_COOLDOWN_MS) return false;
  return true;
}

function emitScan(rawCode: string, source: ScanSource): void {
  const code = normalizeDigits(rawCode).trim();
  if (!code || !opts || !shouldAcceptScan(code)) return;

  if (opts.canScan && !opts.canScan()) {
    toast('نقش مشاهده‌گر اجازه شمارش ندارد', 'error');
    return;
  }
  if (opts.isQtyModalOpen?.()) return;

  lastScanTime = Date.now();
  lastScanCode = code;

  if (scanTargetField) {
    playBeep(true);
    opts.onFieldFill?.(scanTargetField, code);
    toast('بارکد ثبت شد', 'success');

    const continuous =
      (document.getElementById('scannerContinuous') as HTMLInputElement | null)?.checked ??
      opts.getSettings().continuousScan;
    if (!continuous) closeScanner();
    return;
  }

  opts.onScan({ code, source, at: lastScanTime });
}

function getBarcodeFormats(): number[] | undefined {
  const supported = (window as any).Html5QrcodeSupportedFormats as Record<string, number> | undefined;
  if (!supported) return undefined;
  const formats = BARCODE_FORMAT_NAMES
    .map((name) => supported[name])
    .filter((value): value is number => typeof value === 'number');
  return formats.length ? formats : undefined;
}

/**
 * The script is bundled locally in /public. Loading it on demand avoids the
 * race between deferred classic scripts and the application's module script.
 */
async function ensureHtml5Library(): Promise<boolean> {
  if (window.Html5Qrcode) return true;
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="html5-qrcode"]'
    );
    const script = existing ?? document.createElement('script');
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok && !!window.Html5Qrcode);
    };
    const timeout = window.setTimeout(() => finish(false), 9000);

    script.addEventListener('load', () => {
      window.clearTimeout(timeout);
      finish(true);
    }, { once: true });
    script.addEventListener('error', () => {
      window.clearTimeout(timeout);
      finish(false);
    }, { once: true });

    if (!existing) {
      script.src = new URL('./html5-qrcode.min.js', document.baseURI).toString();
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Html5Qrcode) {
      window.clearTimeout(timeout);
      finish(true);
    }
  }).finally(() => {
    if (!window.Html5Qrcode) scriptLoadPromise = null;
  });

  return scriptLoadPromise;
}

async function startCamera(token: number): Promise<void> {
  if (!opts || !isCurrent(token)) return;
  torchOn = false;
  const torchButton = document.getElementById('torchBtn');
  if (torchButton) torchButton.textContent = '🔦 نور';

  const host = document.getElementById(opts.containerId);
  if (!host) {
    toast('محل نمایش دوربین پیدا نشد', 'error');
    return;
  }

  await stopCamera();
  if (!isCurrent(token)) return;

  host.innerHTML = '';
  host.setAttribute('aria-live', 'polite');

  // Html5Qrcode uses the bundled ZXing decoder and is the primary, stable
  // path on Android WebView. Do not rely on BarcodeDetector being present.
  const libraryReady = await ensureHtml5Library();
  if (!isCurrent(token)) return;

  if (libraryReady && await startHtml5(token)) return;
  if (!isCurrent(token)) return;

  if (await startNative(token)) return;
  if (!isCurrent(token)) return;

  toast(
    'اسکنر راه‌اندازی نشد. مجوز دوربین را بررسی کنید یا از ورود دستی/بارکدخوان USB استفاده کنید.',
    'error'
  );
  document.getElementById('manualBarcode')?.focus();
}

async function startHtml5(token: number): Promise<boolean> {
  if (!opts || !window.Html5Qrcode || !isCurrent(token)) return false;

  const host = document.getElementById(opts.containerId);
  if (!host) return false;

  try {
    // A fresh instance avoids stale internal state after interrupted sessions.
    if (html5Instance) {
      try {
        if (html5Running) await html5Instance.stop();
      } catch { /* ignore stale session */ }
      try { await html5Instance.clear(); } catch { /* ignore stale DOM */ }
      html5Instance = null;
      html5Running = false;
    }

    html5Instance = new window.Html5Qrcode(opts.containerId, {
      verbose: false,
      formatsToSupport: getBarcodeFormats(),
    });

    const config: Record<string, unknown> = {
      fps: 15,
      disableFlip: false,
      aspectRatio: 1.7777778,
      experimentalFeatures: { useBarCodeDetectorIfSupported: false },
    };

    const onDecoded = (decodedText: string) => {
      if (!isCurrent(token) || !decodedText) return;
      emitScan(decodedText, 'html5');
    };
    const onDecodeError = () => {
      // Per-frame decode misses are normal; keep the UI quiet.
    };

    // Prefer an identified rear camera, then let the browser resolve facingMode.
    let cameraConfig: string | { facingMode: string } = { facingMode: 'environment' };
    try {
      const cameras = await window.Html5Qrcode.getCameras();
      if (!isCurrent(token)) return false;
      if (Array.isArray(cameras) && cameras.length) {
        const rear = cameras.find((camera: any) =>
          /back|rear|environment|world|پشت|عقب/i.test(camera.label || '')
        );
        cameraConfig = (rear || cameras[cameras.length - 1]).id;
      }
    } catch {
      // Permission prompts and camera enumeration differ across WebViews.
    }

    try {
      await html5Instance.start(cameraConfig, config, onDecoded, onDecodeError);
    } catch (firstError) {
      if (!isCurrent(token)) return false;
      // Retry once with the standard environment constraint when a camera ID
      // selected by WebView is stale or rejected.
      if (typeof cameraConfig === 'string') {
        try {
          try {
            if (html5Instance?.isScanning) await html5Instance.stop();
          } catch { /* release a partially opened camera */ }
          try { await html5Instance?.clear(); } catch { /* clear stale renderer */ }
          html5Instance = new window.Html5Qrcode(opts.containerId, {
            verbose: false,
            formatsToSupport: getBarcodeFormats(),
          });
          await html5Instance.start({ facingMode: 'environment' }, config, onDecoded, onDecodeError);
        } catch (secondError) {
          console.warn('[scanner] html5 start failed', firstError, secondError);
          try {
            if (html5Instance?.isScanning) await html5Instance.stop();
            await html5Instance?.clear();
          } catch { /* ignore cleanup */ }
          html5Instance = null;
          html5Running = false;
          return false;
        }
      } else {
        console.warn('[scanner] html5 start failed', firstError);
        try {
          if (html5Instance?.isScanning) await html5Instance.stop();
          await html5Instance?.clear();
        } catch { /* ignore cleanup */ }
        html5Instance = null;
        html5Running = false;
        return false;
      }
    }

    if (!isCurrent(token)) {
      try { await html5Instance.stop(); } catch { /* ignore */ }
      return false;
    }
    html5Running = true;
    addScannerStatus('دوربین آماده است؛ بارکد را مقابل دوربین بگیرید');
    return true;
  } catch (error) {
    console.error('[scanner] html5 initialization failed', error);
    try {
      if (html5Instance && html5Running) await html5Instance.stop();
      if (html5Instance) await html5Instance.clear();
    } catch { /* ignore cleanup errors */ }
    html5Instance = null;
    html5Running = false;
    return false;
  }
}

async function startNative(token: number): Promise<boolean> {
  const Detector = (window as any).BarcodeDetector;
  if (!navigator.mediaDevices?.getUserMedia || !Detector || !opts) return false;

  const host = document.getElementById(opts.containerId);
  if (!host) return false;

  try {
    const supported: string[] = await Detector.getSupportedFormats();
    const preferred = [
      'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128',
      'code_39', 'itf', 'codabar', 'qr_code', 'data_matrix',
    ];
    const formats = preferred.filter((format) => supported.includes(format));
    if (!formats.length) return false;

    nativeDetector = new Detector({ formats });
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;background:#101817';
    host.innerHTML = '';
    host.appendChild(video);
    nativeVideo = video;

    const constraints: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      { audio: false, video: true },
    ];

    let stream: MediaStream | null = null;
    let lastError: unknown;
    for (const constraint of constraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraint);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!stream) throw lastError || new Error('Camera unavailable');
    if (!isCurrent(token)) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    nativeStream = stream;
    video.srcObject = stream;
    await video.play();
    if (!isCurrent(token)) return false;

    try {
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as any;
      if (capabilities?.focusMode?.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      }
    } catch { /* focus mode is optional */ }

    const loop = async () => {
      if (!isCurrent(token) || !nativeVideo || !nativeDetector) return;
      nativeRaf = requestAnimationFrame(loop);
      if (nativeBusy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      nativeBusy = true;
      try {
        const results = await nativeDetector.detect(video);
        if (isCurrent(token) && results?.length) {
          const value = String(results[0].rawValue || '').trim();
          if (value) emitScan(value, 'native');
        }
      } catch {
        // A frame can be undecodable while focus/exposure adjusts.
      } finally {
        nativeBusy = false;
      }
    };

    nativeRaf = requestAnimationFrame(loop);
    addScannerStatus('دوربین آماده است؛ بارکد را مقابل دوربین بگیرید');
    return true;
  } catch (error) {
    console.warn('[scanner] native fallback failed', error);
    stopNative();
    return false;
  }
}

function addScannerStatus(message: string): void {
  const host = opts ? document.getElementById(opts.containerId) : null;
  if (!host) return;
  let status = document.getElementById('scannerRuntimeStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'scannerRuntimeStatus';
    status.className = 'scanner-runtime-status';
    status.style.cssText =
      'position:absolute;left:8px;right:8px;bottom:8px;z-index:5;text-align:center;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;pointer-events:none';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(status);
  }
  status.textContent = message;
}

function stopNative(): void {
  if (nativeRaf) {
    cancelAnimationFrame(nativeRaf);
    nativeRaf = 0;
  }
  if (nativeStream) {
    nativeStream.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* ignore */ }
    });
    nativeStream = null;
  }
  if (nativeVideo) {
    try { nativeVideo.pause(); } catch { /* ignore */ }
    nativeVideo.srcObject = null;
    nativeVideo = null;
  }
  nativeDetector = null;
  nativeBusy = false;
  torchOn = false;
}

async function stopHtml5(): Promise<void> {
  if (!html5Instance) return;
  try {
    if (html5Running || html5Instance.isScanning) await html5Instance.stop();
  } catch (error) {
    console.debug('[scanner] html5 stop cleanup', error);
  } finally {
    html5Running = false;
    try { await html5Instance.clear(); } catch { /* ignore */ }
  }
}

async function stopCamera(): Promise<void> {
  // Serialize stop operations so a quick close/reopen cannot let an older
  // cleanup tear down the newly opened camera session.
  const operation = lifecycleQueue.then(async () => {
    stopNative();
    await stopHtml5();
    const host = opts ? document.getElementById(opts.containerId) : null;
    if (host) host.innerHTML = '';
  });
  lifecycleQueue = operation.catch(() => undefined);
  await operation;
}

function attachBluetoothListener(): void {
  if (btListenerAttached) return;
  btListenerAttached = true;

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!opts || opts.getSettings().btScanner === false) return;
    const target = event.target as HTMLElement | null;
    const tag = (target?.tagName || '').toLowerCase();

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (tag === 'input' && (target as HTMLInputElement).type === 'number') return;
      if (event.key !== 'Enter') return;
    }

    if (event.key === 'Enter') {
      if (btBuffer.length >= 3) {
        event.preventDefault();
        const code = btBuffer;
        btBuffer = '';
        if (btTimer) clearTimeout(btTimer);
        btTimer = null;
        const status = document.getElementById('btStatus');
        if (status) status.textContent = 'اسکن شد: ' + code;
        emitScan(code, 'bt');
      } else {
        btBuffer = '';
      }
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      btBuffer += event.key;
      if (btTimer) clearTimeout(btTimer);
      btTimer = window.setTimeout(() => { btBuffer = ''; }, 140);
    }
  });
}

export function getScannerCapabilities(): {
  mediaDevices: boolean;
  barcodeDetector: boolean;
  html5Qrcode: boolean;
} {
  return {
    mediaDevices: !!navigator.mediaDevices?.getUserMedia,
    barcodeDetector: typeof (window as any).BarcodeDetector !== 'undefined',
    html5Qrcode: typeof window.Html5Qrcode !== 'undefined',
  };
}
