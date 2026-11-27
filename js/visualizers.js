/**
 * Nagham Studio — HiDPI Canvas Visualizers
 * 1. Dual-Track Waveform Renderer + Live Recording Waveform + Playhead
 * 2. Exact Vocal EQ Frequency Response Curve
 * 3. Master FFT Spectrum Analyzer & Stereo Peak-Hold VU Meters
 */

import { gainToDb, clamp } from './audio-engine.js';

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.floor(rect.width));
  const h = Math.max(10, Math.floor(rect.height));
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Downsample an AudioBuffer into min/max peak pairs for fast waveform rendering.
 */
export function computeWaveformPeaks(audioBuffer, buckets = 600) {
  if (!audioBuffer) return null;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  const len = ch0.length;
  const step = Math.max(1, Math.floor(len / buckets));
  const peaks = new Float32Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(len, start + step);
    let maxVal = 0;
    const stride = Math.max(1, Math.floor((end - start) / 48));
    for (let i = start; i < end; i += stride) {
      const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
      if (v > maxVal) maxVal = v;
    }
    peaks[b] = maxVal;
  }
  return peaks;
}

export function drawWaveformTrack(canvas, {
  peaks,
  bufferDuration = 0,
  totalDuration = 0,
  offsetSec = 0,
  playheadSec = 0,
  color = '#e59a3c',
  bgTint = 'rgba(229, 154, 60, 0.08)',
  muted = false,
  isRecording = false,
  recordPeaks = null,
  recordStartSec = 0,
  emptyLabel = '',
}) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  // Subtle centerline & horizontal guide lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const dur = Math.max(totalDuration, bufferDuration, 1);

  // Time grid marks
  const tickStep = dur > 120 ? 15 : dur > 45 ? 10 : dur > 15 ? 5 : 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.font = '10px "JetBrains Mono", monospace';
  for (let t = tickStep; t < dur; t += tickStep) {
    const x = (t / dur) * w;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Draw live recording waveform if active
  if (isRecording && recordPeaks && recordPeaks.length > 0) {
    const startX = clamp((recordStartSec / dur) * w, 0, w);
    const barW = 2.5;
    const gap = 1;
    ctx.fillStyle = '#ef4444';
    const maxVisible = Math.floor((w - startX) / (barW + gap));
    const startIdx = Math.max(0, recordPeaks.length - maxVisible);
    for (let i = startIdx; i < recordPeaks.length; i++) {
      const x = startX + (i - startIdx) * (barW + gap);
      const amp = Math.max(0.03, Math.min(1, recordPeaks[i] * 1.4));
      const barH = amp * (h * 0.82);
      ctx.fillRect(x, (h - barH) / 2, barW, barH);
    }
  } else if (peaks && bufferDuration > 0) {
    const startX = (offsetSec / dur) * w;
    const clipW = (bufferDuration / dur) * w;

    // Region highlight box
    ctx.fillStyle = muted ? 'rgba(255,255,255,0.03)' : bgTint;
    ctx.fillRect(Math.max(0, startX), 2, Math.min(w - startX, clipW), h - 4);

    // Waveform bars
    const midY = h / 2;
    const maxAmp = h * 0.43;
    const alpha = muted ? 0.25 : 0.92;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;

    const n = peaks.length;
    const barStep = clipW / n;
    const barW = Math.max(1.2, barStep * 0.72);

    for (let i = 0; i < n; i++) {
      const x = startX + i * barStep;
      if (x + barW < 0 || x > w) continue;
      const amp = Math.max(1.5, peaks[i] * maxAmp);
      ctx.fillRect(x, midY - amp, barW, amp * 2);
    }
    ctx.globalAlpha = 1;
  } else if (emptyLabel) {
    ctx.fillStyle = 'rgba(242, 239, 233, 0.35)';
    ctx.font = '500 12px "Cairo", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emptyLabel, w / 2, h / 2);
  }

  // Playhead cursor
  if (totalDuration > 0 || isRecording) {
    const px = clamp((playheadSec / dur) * w, 0, w);
    ctx.strokeStyle = isRecording ? '#ef4444' : '#f8fafc';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    // Small top triangle indicator
    ctx.fillStyle = isRecording ? '#ef4444' : '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Draw the exact Vocal EQ + HPF + De-Esser frequency response curve.
 */
export function drawEqCurve(canvas, engine) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const minFreq = 20;
  const maxFreq = 20000;
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);

  const freqToX = (f) => ((Math.log10(f) - logMin) / (logMax - logMin)) * w;
  const dbToY = (db) => {
    const clamped = clamp(db, -15, 15);
    return h / 2 - (clamped / 15) * (h * 0.44);
  };

  // Grid lines (dB)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [-12, -6, 0, 6, 12].forEach((db) => {
    const y = dbToY(db);
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  });

  // Grid lines (Frequency)
  const labelFreqs = [
    { f: 50, t: '50' },
    { f: 100, t: '100' },
    { f: 400, t: '400' },
    { f: 1000, t: '1k' },
    { f: 3200, t: '3.2k' },
    { f: 6800, t: '6.8k' },
    { f: 10000, t: '10k' },
  ];
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.textAlign = 'center';
  labelFreqs.forEach(({ f, t }) => {
    const x = freqToX(f);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h - 14);
    ctx.stroke();
    ctx.fillText(t, x, h - 3);
  });

  // Evaluate exact Biquad frequency response
  const numPts = Math.min(240, Math.max(100, Math.floor(w / 2)));
  const freqs = new Float32Array(numPts);
  for (let i = 0; i < numPts; i++) {
    const frac = i / (numPts - 1);
    freqs[i] = Math.pow(10, logMin + frac * (logMax - logMin));
  }
  const dbVals = engine.getVocalEqCurve(freqs);

  // Fill under curve relative to 0 dB
  const zeroY = dbToY(0);
  const enabled = engine.state.vocal.fxEnabled;
  const strokeCol = enabled ? '#e59a3c' : 'rgba(255,255,255,0.35)';

  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  for (let i = 0; i < numPts; i++) {
    const x = (i / (numPts - 1)) * w;
    const y = dbToY(dbVals[i]);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, zeroY);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, enabled ? 'rgba(229, 154, 60, 0.28)' : 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.5, enabled ? 'rgba(229, 154, 60, 0.06)' : 'rgba(255,255,255,0.02)');
  grad.addColorStop(1, enabled ? 'rgba(56, 189, 248, 0.16)' : 'rgba(255,255,255,0.05)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Curve stroke
  ctx.beginPath();
  for (let i = 0; i < numPts; i++) {
    const x = (i / (numPts - 1)) * w;
    const y = dbToY(dbVals[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // Draw EQ band anchor dots
  const fx = engine.state.vocalFx;
  const bands = [
    { f: fx.hpfFreq, db: -3, color: '#ef4444' },
    { f: 100, db: fx.eqLow, color: '#e59a3c' },
    { f: 380, db: fx.eqWarmth, color: '#e59a3c' },
    { f: 3200, db: fx.eqPresence, color: '#38bdf8' },
    { f: 10000, db: fx.eqAir, color: '#38bdf8' },
  ];
  bands.forEach((b) => {
    const x = freqToX(clamp(b.f, 22, 18000));
    const y = dbToY(b.db);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = enabled ? b.color : '#64748b';
    ctx.fill();
    ctx.strokeStyle = '#111317';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

/**
 * Draw real-time FFT Spectrum Analyzer on the Master panel.
 */
export function drawSpectrum(canvas, fftData) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  // Subtle horizontal reference grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((f) => {
    ctx.beginPath();
    ctx.moveTo(0, h * f);
    ctx.lineTo(w, h * f);
    ctx.stroke();
  });

  if (!fftData || fftData.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '11px "Cairo", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('اضغط تشغيل لعرض الطيف الترددي المباشر (FFT)', w / 2, h / 2);
    return;
  }

  const bars = 48;
  const barGap = 2;
  const barW = Math.max(2, (w - (bars - 1) * barGap) / bars);

  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, '#22c55e');
  grad.addColorStop(0.65, '#e59a3c');
  grad.addColorStop(1, '#ef4444');
  ctx.fillStyle = grad;

  // Logarithmically map FFT bins so bass, mids, and highs are balanced visually
  const maxBin = fftData.length - 1;
  for (let i = 0; i < bars; i++) {
    const startFrac = Math.pow(i / bars, 1.85);
    const endFrac = Math.pow((i + 1) / bars, 1.85);
    const binStart = Math.floor(startFrac * maxBin);
    const binEnd = Math.max(binStart + 1, Math.floor(endFrac * maxBin));
    let sum = 0;
    for (let b = binStart; b < binEnd && b < fftData.length; b++) {
      sum += fftData[b];
    }
    const avg = sum / Math.max(1, binEnd - binStart);
    const norm = avg / 255;
    const barH = Math.max(2, norm * (h - 6));
    const x = i * (barW + barGap);
    ctx.fillRect(x, h - barH, barW, barH);
  }
}

/**
 * Draw Stereo VU Meter (Vertical or Horizontal) with smooth Peak Hold.
 */
export class StereoVuMeter {
  constructor() {
    this.peakL = 0;
    this.peakR = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.holdDecay = 0.008;
  }

  update(levelL, levelR) {
    const dbL = clamp((gainToDb(levelL) + 60) / 60, 0, 1);
    const dbR = clamp((gainToDb(levelR) + 60) / 60, 0, 1);

    this.peakL = dbL > this.peakL ? dbL : this.peakL * 0.88 + dbL * 0.12;
    this.peakR = dbR > this.peakR ? dbR : this.peakR * 0.88 + dbR * 0.12;

    if (dbL >= this.holdL) this.holdL = dbL;
    else this.holdL = Math.max(0, this.holdL - this.holdDecay);

    if (dbR >= this.holdR) this.holdR = dbR;
    else this.holdR = Math.max(0, this.holdR - this.holdDecay);
  }

  draw(canvas) {
    const { ctx, w, h } = prepCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const drawBar = (val, hold, y, barH) => {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, y, w, barH);

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#22c55e');
      grad.addColorStop(0.75, '#e59a3c');
      grad.addColorStop(0.94, '#ef4444');
      ctx.fillStyle = grad;
      ctx.fillRect(0, y, val * w, barH);

      if (hold > 0.02) {
        const hx = Math.min(w - 2, hold * w);
        ctx.fillStyle = hold > 0.92 ? '#ef4444' : '#f8fafc';
        ctx.fillRect(hx, y, 2, barH);
      }
    };

    const barH = Math.floor((h - 4) / 2);
    drawBar(this.peakL, this.holdL, 0, barH);
    drawBar(this.peakR, this.holdR, barH + 4, barH);
  }

  drawVertical(canvas) {
    if (!canvas) return;
    const { ctx, w, h } = prepCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const drawCol = (val, hold, x, colW) => {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, 0, colW, h);

      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#6cd957');
      grad.addColorStop(0.75, '#ff8b2b');
      grad.addColorStop(0.94, '#ef4747');
      ctx.fillStyle = grad;
      const fillH = val * h;
      ctx.fillRect(x, h - fillH, colW, fillH);

      if (hold > 0.02) {
        const hy = Math.max(0, h - hold * h);
        ctx.fillStyle = hold > 0.92 ? '#ef4747' : '#f8fafc';
        ctx.fillRect(x, hy, colW, 2);
      }
    };

    const colW = Math.max(3, Math.floor((w - 2) / 2));
    drawCol(this.peakL, this.holdL, 0, colW);
    drawCol(this.peakR, this.holdR, colW + 2, colW);
  }
}

/**
 * Draw Auto-Tune Pitch Correction Graph (Original Sung Pitch vs Corrected Pitch)
 */
export function drawAutoTuneGraph(canvas, stats, durationSec = 0, playheadSec = 0, enabled = false) {
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  // Subtle horizontal semitone lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = (h / 6) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!enabled) {
    ctx.fillStyle = 'rgba(242, 239, 233, 0.34)';
    ctx.font = '11px "Cairo", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('الأوتو تيون مغلق حالياً — اضغط «تشغيل الأوتو تيون» لتصحيح النغمات وعرض منحنى التصحيح', w / 2, h / 2);
    return;
  }

  const contour = stats?.contour;
  if (!contour || contour.length < 2) {
    ctx.fillStyle = 'rgba(242, 239, 233, 0.4)';
    ctx.font = '11px "Cairo", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('سجّل صوتك أو شغّل الفوكال لعرض منحنى تصحيح الأوتو تيون (الأصلي مقابل المُصحّح)', w / 2, h / 2);
    return;
  }

  // Find MIDI min/max range
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  for (const pt of contour) {
    if (pt.rawMidi < minMidi) minMidi = pt.rawMidi;
    if (pt.rawMidi > maxMidi) maxMidi = pt.rawMidi;
    if (pt.tunedMidi < minMidi) minMidi = pt.tunedMidi;
    if (pt.tunedMidi > maxMidi) maxMidi = pt.tunedMidi;
  }
  minMidi = Math.floor(minMidi - 1.5);
  maxMidi = Math.ceil(maxMidi + 1.5);
  const midiSpan = Math.max(4, maxMidi - minMidi);
  const dur = Math.max(durationSec, contour[contour.length - 1].t, 0.5);

  const toX = (t) => (t / dur) * w;
  const toY = (m) => h - 10 - ((m - minMidi) / midiSpan) * (h - 20);

  // Plot original sung pitch (subtle cyan dashed)
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  let lastT = -10;
  for (const pt of contour) {
    const x = toX(pt.t);
    const y = toY(pt.rawMidi);
    if (pt.t - lastT > 0.14) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    lastT = pt.t;
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Plot Auto-Tuned pitch (crisp warm amber solid)
  ctx.strokeStyle = '#e59a3c';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  lastT = -10;
  for (const pt of contour) {
    const x = toX(pt.t);
    const y = toY(pt.tunedMidi);
    if (pt.t - lastT > 0.14) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    lastT = pt.t;
  }
  ctx.stroke();

  // Live Playhead
  if (playheadSec > 0 && playheadSec <= dur) {
    const px = toX(playheadSec);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
}
