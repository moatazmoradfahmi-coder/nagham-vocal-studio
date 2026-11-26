/**
 * Nagham Studio — Complete Web Audio DSP Engine, Multi-Track Recorder,
 * Creative Vocal FX & Harmony Engine, Precision Metronome, Built-in Beat
 * Synthesizer, Offline Mixer/Masterer, and Real MP3/WAV Encoder
 */

import { DEFAULT_MIX_STATE } from './presets.js';
import { applyAutoTuneToBuffer } from './autotune.js';

export function dbToGain(db) {
  if (db <= -60) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain) {
  if (gain <= 0.00001) return -60;
  return 20 * Math.log10(gain);
}

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Procedurally generate a realistic stereo Impulse Response buffer for Convolution Reverb.
 */
export function createReverbIR(ctx, type = 'studio', decaySec = 1.6) {
  const sampleRate = ctx.sampleRate;
  const duration = clamp(decaySec, 0.3, 6.0);
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);

  const configs = {
    room:      { damp: 0.45, earlyCount: 10, earlySpread: 0.025, bright: 0.65 },
    studio:    { damp: 0.35, earlyCount: 14, earlySpread: 0.035, bright: 0.78 },
    hall:      { damp: 0.25, earlyCount: 18, earlySpread: 0.065, bright: 0.72 },
    cathedral: { damp: 0.18, earlyCount: 22, earlySpread: 0.095, bright: 0.62 },
    plate:     { damp: 0.15, earlyCount: 8,  earlySpread: 0.015, bright: 0.92 },
  };
  const cfg = configs[type] || configs.studio;

  let seed = 1337 + type.length * 97 + Math.round(decaySec * 100);
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646 * 2 - 1;
  };

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lpState = 0;
    const lpAlpha = cfg.bright;

    for (let i = 0; i < length; i++) {
      const t = i / length;
      const attack = Math.min(1, i / (sampleRate * 0.008));
      const env = attack * Math.pow(1 - t, 2.2 + cfg.damp * 2.5);
      const raw = rand();
      const dynamicAlpha = Math.max(0.08, lpAlpha * (1 - t * 0.65));
      lpState = lpState + dynamicAlpha * (raw - lpState);
      data[i] = lpState * env * 0.55;
    }

    for (let r = 0; r < cfg.earlyCount; r++) {
      const delaySec = 0.004 + (r / cfg.earlyCount) * cfg.earlySpread + (ch === 1 ? 0.0017 : 0);
      const idx = Math.floor(delaySec * sampleRate);
      if (idx < length) {
        const amp = (1 - r / cfg.earlyCount) * 0.35 * (r % 2 === 0 ? 1 : -1);
        data[idx] += amp;
      }
    }
  }

  return buffer;
}

/**
 * Create a smooth asymmetric analog tube warmth WaveShaper curve.
 */
export function createWarmthCurve(amountPercent) {
  const n = 2048;
  const curve = new Float32Array(n);
  const drive = clamp(amountPercent, 0, 100) / 100;
  if (drive <= 0.001) {
    for (let i = 0; i < n; i++) curve[i] = (i * 2) / (n - 1) - 1;
    return curve;
  }
  const k = 1 + drive * 3.8;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const shaped = (Math.tanh(k * (x + 0.04 * drive)) - Math.tanh(0.04 * drive * k)) / norm;
    curve[i] = x * (1 - drive * 0.65) + shaped * (drive * 0.65);
  }
  return curve;
}

/**
 * Create a musical vocal Overdrive / Grit WaveShaper curve.
 */
export function createOverdriveCurve(amountPercent) {
  const n = 2048;
  const curve = new Float32Array(n);
  const amt = clamp(amountPercent, 0, 100) / 100;
  if (amt <= 0.001) {
    for (let i = 0; i < n; i++) curve[i] = (i * 2) / (n - 1) - 1;
    return curve;
  }
  const k = 2 + amt * 18;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Create a transparent soft-knee brickwall limiter ceiling curve.
 */
export function createLimiterClipperCurve(ceilingDb) {
  const n = 4096;
  const curve = new Float32Array(n);
  const ceil = dbToGain(clamp(ceilingDb, -6, -0.05));
  const kneeStart = ceil * 0.88;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const ax = Math.abs(x);
    if (ax <= kneeStart) {
      curve[i] = x;
    } else {
      const over = ax - kneeStart;
      const range = ceil - kneeStart;
      const compressed = kneeStart + range * Math.tanh(over / Math.max(0.0001, range));
      curve[i] = Math.sign(x) * Math.min(ceil, compressed);
    }
  }
  return curve;
}

/**
 * Non-destructive envelope-based Noise Gate for vocal buffers.
 */
export function applyNoiseGate(ctx, srcBuffer, thresholdDb) {
  if (!srcBuffer || thresholdDb <= -78) return srcBuffer;

  const numCh = srcBuffer.numberOfChannels;
  const len = srcBuffer.length;
  const sr = srcBuffer.sampleRate;
  const out = ctx.createBuffer(numCh, len, sr);

  const threshLin = dbToGain(thresholdDb);
  const floorGain = dbToGain(-34);
  const attackCoeff = Math.exp(-1 / (sr * 0.006));
  const releaseCoeff = Math.exp(-1 / (sr * 0.11));
  const envCoeff = Math.exp(-1 / (sr * 0.012));
  const holdSamples = Math.floor(sr * 0.065);

  const ch0 = srcBuffer.getChannelData(0);
  const ch1 = numCh > 1 ? srcBuffer.getChannelData(1) : ch0;

  let env = 0;
  let gateGain = floorGain;
  let holdCounter = 0;

  const out0 = out.getChannelData(0);
  const out1 = numCh > 1 ? out.getChannelData(1) : null;

  for (let i = 0; i < len; i++) {
    const level = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
    env = envCoeff * env + (1 - envCoeff) * level;

    let target = floorGain;
    if (env >= threshLin) {
      target = 1.0;
      holdCounter = holdSamples;
    } else if (holdCounter > 0) {
      target = 1.0;
      holdCounter--;
    }

    const coeff = target > gateGain ? attackCoeff : releaseCoeff;
    gateGain = coeff * gateGain + (1 - coeff) * target;

    out0[i] = ch0[i] * gateGain;
    if (out1) out1[i] = ch1[i] * gateGain;
  }

  return out;
}

/**
 * Time-preserving WSOLA (Waveform-Similarity Overlap-Add) granular pitch shifter
 * for creating clean, phase-coherent vocal harmonies (octave, fifth, third).
 */
export function createPitchShiftedHarmonyBuffer(ctx, srcBuffer, semitones = 7) {
  if (!srcBuffer || semitones === 0) return srcBuffer;

  const sr = srcBuffer.sampleRate;
  const len = srcBuffer.length;
  const pitchFactor = Math.pow(2, semitones / 12);

  const input = srcBuffer.getChannelData(0);
  const out = ctx.createBuffer(2, len, sr);
  const outL = out.getChannelData(0);
  const outR = out.getChannelData(1);

  const grainSize = 2048;
  const hop = 1024; // 2x Hann overlap sums to exact 1.0
  const win = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
  }

  const readSample = (pos) => {
    const i0 = Math.floor(pos);
    if (i0 < 0 || i0 + 1 >= len) return 0;
    const frac = pos - i0;
    return input[i0] * (1 - frac) + input[i0 + 1] * frac;
  };

  const searchRadius = Math.min(260, Math.floor(sr / 150));
  const matchLen = 256;

  for (let outStart = 0; outStart < len; outStart += hop) {
    let bestOffset = 0;

    // Phase-align new grain against already synthesized overlap tail (WSOLA)
    if (outStart > 0) {
      let bestScore = -Infinity;
      const maxSearch = Math.min(searchRadius, Math.floor(len - outStart - grainSize * pitchFactor));
      const minSearch = Math.max(-searchRadius, -outStart);

      for (let d = minSearch; d <= maxSearch; d += 4) {
        let corr = 0;
        for (let m = 0; m < matchLen; m += 4) {
          const dstIdx = outStart + m;
          if (dstIdx >= len) break;
          corr += outL[dstIdx] * readSample(outStart + d + m * pitchFactor);
        }
        if (corr > bestScore) {
          bestScore = corr;
          bestOffset = d;
        }
      }
      // Fine refinement around best coarse offset
      const refineStart = Math.max(minSearch, bestOffset - 3);
      const refineEnd = Math.min(maxSearch, bestOffset + 3);
      for (let d = refineStart; d <= refineEnd; d++) {
        let corr = 0;
        for (let m = 0; m < matchLen; m += 2) {
          const dstIdx = outStart + m;
          if (dstIdx >= len) break;
          corr += outL[dstIdx] * readSample(outStart + d + m * pitchFactor);
        }
        if (corr > bestScore) {
          bestScore = corr;
          bestOffset = d;
        }
      }
    }

    const baseSrc = outStart + bestOffset;
    for (let i = 0; i < grainSize; i++) {
      const dstIdx = outStart + i;
      if (dstIdx >= len) break;
      const s = readSample(baseSrc + i * pitchFactor) * win[i];
      outL[dstIdx] += s;
      // Slight stereo Haas spread (~9 ms) on right channel for lush harmony width
      const dstR = dstIdx + 400;
      if (dstR < len) outR[dstR] += s;
    }
  }

  return out;
}

/**
 * Compute a smooth ducking gain curve for the backing track based on vocal activity.
 */
export function computeAutoDuckingCurve(vocalBuffer, duckingDb, totalDuration, syncOffsetSec = 0, stepSec = 0.05) {
  const numSteps = Math.max(2, Math.ceil(totalDuration / stepSec) + 1);
  const curve = new Float32Array(numSteps);
  curve.fill(1.0);
  if (!vocalBuffer || duckingDb <= 0.05) return curve;

  const sr = vocalBuffer.sampleRate;
  const data = vocalBuffer.getChannelData(0);
  const minGain = dbToGain(-clamp(duckingDb, 0, 8));
  const windowSamples = Math.max(1, Math.floor(sr * stepSec));

  let smoothGain = 1.0;
  for (let s = 0; s < numSteps; s++) {
    const t = s * stepSec - syncOffsetSec;
    let rms = 0;
    if (t >= 0) {
      const startIdx = Math.floor(t * sr);
      const endIdx = Math.min(data.length, startIdx + windowSamples);
      if (startIdx < data.length && endIdx > startIdx) {
        let sumSq = 0;
        for (let i = startIdx; i < endIdx; i += 4) {
          sumSq += data[i] * data[i];
        }
        rms = Math.sqrt(sumSq / Math.max(1, (endIdx - startIdx) / 4));
      }
    }
    const vocalDb = gainToDb(rms);
    const activity = clamp((vocalDb - (-42)) / 24, 0, 1);
    const target = 1.0 - activity * (1.0 - minGain);
    const alpha = target < smoothGain ? 0.45 : 0.16;
    smoothGain = smoothGain + alpha * (target - smoothGain);
    curve[s] = smoothGain;
  }
  return curve;
}

function getLofiFilterSpec(style) {
  if (style === 'telephone') return { hp: 460, lp: 2600, peakFreq: 1450, peakGain: 5.5, peakQ: 1.8 };
  if (style === 'megaphone') return { hp: 620, lp: 3800, peakFreq: 1900, peakGain: 8.5, peakQ: 2.2 };
  return { hp: 280, lp: 3500, peakFreq: 1150, peakGain: 3.5, peakQ: 1.2 }; // vintage radio
}

/**
 * Build the complete Vocal FX Audio Graph inside either live AudioContext or OfflineAudioContext.
 * Supports per-module bypass toggles and all creative vocal effects.
 */
export function buildVocalFxChain(ctx, state, reverbIR) {
  const fx = state.vocalFx;
  const input = ctx.createGain();
  const eqOn = fx.eqEnabled !== false;

  // 1. High-Pass Filter
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = eqOn ? fx.hpfFreq : 20;
  hpf.Q.value = 0.707;

  // 2. 4-Band Vocal EQ
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 100;
  eqLow.gain.value = eqOn ? fx.eqLow : 0;

  const eqWarmth = ctx.createBiquadFilter();
  eqWarmth.type = 'peaking';
  eqWarmth.frequency.value = 380;
  eqWarmth.Q.value = 1.0;
  eqWarmth.gain.value = eqOn ? fx.eqWarmth : 0;

  const eqPresence = ctx.createBiquadFilter();
  eqPresence.type = 'peaking';
  eqPresence.frequency.value = 3200;
  eqPresence.Q.value = 1.2;
  eqPresence.gain.value = eqOn ? fx.eqPresence : 0;

  const eqAir = ctx.createBiquadFilter();
  eqAir.type = 'highshelf';
  eqAir.frequency.value = 10000;
  eqAir.gain.value = eqOn ? fx.eqAir : 0;

  // 3. De-Esser
  const deEsser = ctx.createBiquadFilter();
  deEsser.type = 'peaking';
  deEsser.frequency.value = 6800;
  deEsser.Q.value = 2.8;
  deEsser.gain.value = eqOn ? -(fx.deEsser / 100) * 11 : 0;

  // 4. Analog Tube Warmth
  const warmth = ctx.createWaveShaper();
  warmth.curve = createWarmthCurve(eqOn ? fx.warmth : 0);
  warmth.oversample = '4x';

  // 5. Vocal Drive / Overdrive (with bypassable blend)
  const driveShaper = ctx.createWaveShaper();
  driveShaper.curve = createOverdriveCurve(fx.driveAmount || 0);
  driveShaper.oversample = '4x';
  const driveTone = ctx.createBiquadFilter();
  driveTone.type = 'lowpass';
  driveTone.frequency.value = 5400;
  const driveWet = ctx.createGain();
  const driveDry = ctx.createGain();
  const driveSum = ctx.createGain();
  const driveAmt = fx.driveEnabled ? clamp((fx.driveAmount || 0) / 100, 0, 1) * 0.72 : 0;
  driveWet.gain.value = driveAmt;
  driveDry.gain.value = 1 - driveAmt * 0.55;

  warmth.connect(driveDry);
  driveDry.connect(driveSum);
  warmth.connect(driveShaper);
  driveShaper.connect(driveTone);
  driveTone.connect(driveWet);
  driveWet.connect(driveSum);

  // 6. Lo-Fi / Telephone / Radio / Megaphone Filter (parallel wet/dry)
  const lofiSpec = getLofiFilterSpec(fx.lofiStyle);
  const lofiHp = ctx.createBiquadFilter();
  lofiHp.type = 'highpass';
  lofiHp.frequency.value = lofiSpec.hp;
  const lofiLp = ctx.createBiquadFilter();
  lofiLp.type = 'lowpass';
  lofiLp.frequency.value = lofiSpec.lp;
  const lofiPeak = ctx.createBiquadFilter();
  lofiPeak.type = 'peaking';
  lofiPeak.frequency.value = lofiSpec.peakFreq;
  lofiPeak.Q.value = lofiSpec.peakQ;
  lofiPeak.gain.value = lofiSpec.peakGain;

  const lofiDry = ctx.createGain();
  const lofiWet = ctx.createGain();
  const lofiSum = ctx.createGain();
  const lofiRatio = fx.lofiEnabled ? clamp((fx.lofiMix || 0) / 100, 0, 1) : 0;
  lofiWet.gain.value = lofiRatio;
  lofiDry.gain.value = 1 - lofiRatio;

  driveSum.connect(lofiDry);
  lofiDry.connect(lofiSum);
  driveSum.connect(lofiHp);
  lofiHp.connect(lofiLp);
  lofiLp.connect(lofiPeak);
  lofiPeak.connect(lofiWet);
  lofiWet.connect(lofiSum);

  // 7. Compressor + Makeup Gain (with per-module toggle)
  const compOn = fx.compEnabled !== false;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = fx.compThreshold;
  comp.knee.value = 8;
  comp.ratio.value = Math.max(1, fx.compRatio);
  comp.attack.value = fx.compAttack / 1000;
  comp.release.value = fx.compRelease / 1000;

  const compMakeup = ctx.createGain();
  compMakeup.gain.value = dbToGain(fx.compMakeup);

  const compActiveGain = ctx.createGain();
  const compBypassGain = ctx.createGain();
  const postComp = ctx.createGain();
  compActiveGain.gain.value = compOn ? 1 : 0;
  compBypassGain.gain.value = compOn ? 0 : 1;

  // Wire serial vocal strip
  input.connect(hpf);
  hpf.connect(eqLow);
  eqLow.connect(eqWarmth);
  eqWarmth.connect(eqPresence);
  eqPresence.connect(eqAir);
  eqAir.connect(deEsser);
  deEsser.connect(warmth);

  lofiSum.connect(comp);
  comp.connect(compMakeup);
  compMakeup.connect(compActiveGain);
  compActiveGain.connect(postComp);
  lofiSum.connect(compBypassGain);
  compBypassGain.connect(postComp);

  // 8. Flanger / Phaser Modulation FX (parallel wet/dry)
  const modLfo = ctx.createOscillator();
  modLfo.type = 'sine';
  modLfo.frequency.value = fx.modRate || 0.6;

  // Flanger branch
  const flangerDelay = ctx.createDelay(0.05);
  flangerDelay.delayTime.value = 0.006;
  const flangerDepth = ctx.createGain();
  flangerDepth.gain.value = ((fx.modDepth || 40) / 100) * 0.0045;
  const flangerFb = ctx.createGain();
  flangerFb.gain.value = 0.35;
  const flangerWet = ctx.createGain();

  modLfo.connect(flangerDepth);
  flangerDepth.connect(flangerDelay.delayTime);
  postComp.connect(flangerDelay);
  flangerDelay.connect(flangerFb);
  flangerFb.connect(flangerDelay);
  flangerDelay.connect(flangerWet);

  // Phaser branch (3 cascaded Allpass filters swept by LFO)
  const phaserAp1 = ctx.createBiquadFilter(); phaserAp1.type = 'allpass'; phaserAp1.frequency.value = 900; phaserAp1.Q.value = 1.6;
  const phaserAp2 = ctx.createBiquadFilter(); phaserAp2.type = 'allpass'; phaserAp2.frequency.value = 1600; phaserAp2.Q.value = 1.6;
  const phaserAp3 = ctx.createBiquadFilter(); phaserAp3.type = 'allpass'; phaserAp3.frequency.value = 2600; phaserAp3.Q.value = 1.6;
  const phaserDepth = ctx.createGain();
  phaserDepth.gain.value = ((fx.modDepth || 40) / 100) * 700;
  const phaserWet = ctx.createGain();

  modLfo.connect(phaserDepth);
  phaserDepth.connect(phaserAp1.frequency);
  phaserDepth.connect(phaserAp2.frequency);
  phaserDepth.connect(phaserAp3.frequency);

  postComp.connect(phaserAp1);
  phaserAp1.connect(phaserAp2);
  phaserAp2.connect(phaserAp3);
  phaserAp3.connect(phaserWet);

  modLfo.start(0);

  const modMixRatio = fx.modEnabled ? clamp((fx.modMix || 0) / 100, 0, 1) * 0.72 : 0;
  flangerWet.gain.value = fx.modType === 'flanger' ? modMixRatio : 0;
  phaserWet.gain.value = fx.modType === 'phaser' ? modMixRatio : 0;

  // Post-dynamics bus (Dry + Parallel FX)
  const fxSum = ctx.createGain();
  const dryGain = ctx.createGain();
  dryGain.gain.value = 1.0;
  postComp.connect(dryGain);
  dryGain.connect(fxSum);
  flangerWet.connect(fxSum);
  phaserWet.connect(fxSum);

  // 9. Stereo Doubler / Chorus
  const doublerWet = ctx.createGain();
  doublerWet.gain.value = (fx.doublerMix / 100) * 0.45;
  const dblDelayL = ctx.createDelay(0.1);
  const dblDelayR = ctx.createDelay(0.1);
  dblDelayL.delayTime.value = 0.015;
  dblDelayR.delayTime.value = 0.024;

  const dblLfoL = ctx.createOscillator();
  const dblLfoR = ctx.createOscillator();
  const dblDepthL = ctx.createGain();
  const dblDepthR = ctx.createGain();
  dblLfoL.frequency.value = 0.42;
  dblLfoR.frequency.value = 0.58;
  dblDepthL.gain.value = 0.0022;
  dblDepthR.gain.value = 0.0026;
  dblLfoL.connect(dblDepthL);
  dblDepthL.connect(dblDelayL.delayTime);
  dblLfoR.connect(dblDepthR);
  dblDepthR.connect(dblDelayR.delayTime);
  dblLfoL.start(0);
  dblLfoR.start(0);

  const dblPanL = ctx.createStereoPanner();
  const dblPanR = ctx.createStereoPanner();
  dblPanL.pan.value = -0.82;
  dblPanR.pan.value = 0.82;

  postComp.connect(dblDelayL);
  postComp.connect(dblDelayR);
  dblDelayL.connect(dblPanL);
  dblDelayR.connect(dblPanR);
  dblPanL.connect(doublerWet);
  dblPanR.connect(doublerWet);
  doublerWet.connect(fxSum);

  // 10. Convolution Reverb Send (with toggle)
  const revOn = fx.reverbEnabled !== false;
  const revPreDelay = ctx.createDelay(0.25);
  revPreDelay.delayTime.value = fx.reverbPreDelay / 1000;
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbIR || createReverbIR(ctx, fx.reverbType, fx.reverbDecay);
  const revWet = ctx.createGain();
  revWet.gain.value = revOn ? (fx.reverbMix / 100) * 0.95 : 0;

  postComp.connect(revPreDelay);
  revPreDelay.connect(convolver);
  convolver.connect(revWet);
  revWet.connect(fxSum);

  // 11. Stereo Warm Delay Send (with toggle)
  const delOn = fx.delayEnabled !== false;
  const delayNode = ctx.createDelay(1.2);
  delayNode.delayTime.value = fx.delayTimeMs / 1000;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = fx.delayToneHz;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = clamp(fx.delayFeedback / 100, 0, 0.78);
  const delayWet = ctx.createGain();
  delayWet.gain.value = delOn ? (fx.delayMix / 100) * 0.75 : 0;

  postComp.connect(delayNode);
  delayNode.connect(delayTone);
  delayTone.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayTone.connect(delayWet);
  delayWet.connect(fxSum);

  // Optional Harmony Input (feeds into Reverb + fxSum for cohesive choir blend)
  const harmonyInput = ctx.createGain();
  harmonyInput.gain.value = fx.harmonyEnabled ? clamp((fx.harmonyMix || 0) / 100, 0, 1) * 0.85 : 0;
  harmonyInput.connect(fxSum);
  harmonyInput.connect(revPreDelay);

  // Master Vocal FX Bypass switching node
  const bypassGain = ctx.createGain();
  const activeGain = ctx.createGain();
  const output = ctx.createGain();

  const enabled = state.vocal.fxEnabled;
  activeGain.gain.value = enabled ? 1 : 0;
  bypassGain.gain.value = enabled ? 0 : 1;

  input.connect(bypassGain);
  bypassGain.connect(output);
  fxSum.connect(activeGain);
  activeGain.connect(output);

  return {
    input,
    harmonyInput,
    output,
    nodes: {
      hpf, eqLow, eqWarmth, eqPresence, eqAir, deEsser, warmth,
      driveShaper, driveWet, driveDry,
      lofiHp, lofiLp, lofiPeak, lofiWet, lofiDry,
      comp, compMakeup, compActiveGain, compBypassGain,
      modLfo, flangerDepth, flangerWet, phaserDepth, phaserWet,
      doublerWet, revPreDelay, convolver, revWet,
      delayNode, delayTone, delayFeedback, delayWet,
      harmonyInput, activeGain, bypassGain, dblLfoL, dblLfoR,
    },
    stopOscillators() {
      try { dblLfoL.stop(); } catch {}
      try { dblLfoR.stop(); } catch {}
      try { modLfo.stop(); } catch {}
    },
  };
}

/**
 * Build the complete Mastering Chain (Master 3-Band EQ, True M/S Stereo Width,
 * Glue Bus Compressor, Brickwall Limiter/Maximizer, Master Volume).
 */
export function buildMasterChain(ctx, state) {
  const m = state.master;
  const input = ctx.createGain();

  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 80;
  eqLow.gain.value = m.eqLow;

  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1200;
  eqMid.Q.value = 0.8;
  eqMid.gain.value = m.eqMid;

  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 11000;
  eqHigh.gain.value = m.eqHigh;

  // True Mid/Side Stereo Widener
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const midL = ctx.createGain(); midL.gain.value = 0.5;
  const midR = ctx.createGain(); midR.gain.value = 0.5;
  const midBus = ctx.createGain();

  const sideL = ctx.createGain(); sideL.gain.value = 0.5;
  const sideR = ctx.createGain(); sideR.gain.value = -0.5;
  const sideWidthGain = ctx.createGain();
  sideWidthGain.gain.value = m.stereoWidth / 100;

  const sideInv = ctx.createGain();
  sideInv.gain.value = -1;

  splitter.connect(midL, 0);
  splitter.connect(midR, 1);
  midL.connect(midBus);
  midR.connect(midBus);

  splitter.connect(sideL, 0);
  splitter.connect(sideR, 1);
  sideL.connect(sideWidthGain);
  sideR.connect(sideWidthGain);
  sideWidthGain.connect(sideInv);

  midBus.connect(merger, 0, 0);
  sideWidthGain.connect(merger, 0, 0);
  midBus.connect(merger, 0, 1);
  sideInv.connect(merger, 0, 1);

  // Glue Bus Compressor
  const glueRatio = 1 + (m.glueAmount / 100) * 2.5;
  const glueThresh = -(m.glueAmount / 100) * 18;
  const glueComp = ctx.createDynamicsCompressor();
  glueComp.threshold.value = glueThresh;
  glueComp.knee.value = 12;
  glueComp.ratio.value = glueRatio;
  glueComp.attack.value = 0.022;
  glueComp.release.value = 0.22;

  const glueMakeup = ctx.createGain();
  glueMakeup.gain.value = dbToGain((m.glueAmount / 100) * 2.2);

  // Maximizer / Brickwall Limiter
  const limiterDrive = ctx.createGain();
  limiterDrive.gain.value = dbToGain(m.limiterDrive);

  const limiterComp = ctx.createDynamicsCompressor();
  limiterComp.threshold.value = clamp(m.limiterCeiling - 1.5, -12, -0.5);
  limiterComp.knee.value = 0;
  limiterComp.ratio.value = 20;
  limiterComp.attack.value = 0.001;
  limiterComp.release.value = 0.065;

  const limiterClipper = ctx.createWaveShaper();
  limiterClipper.curve = createLimiterClipperCurve(m.limiterCeiling);
  limiterClipper.oversample = '4x';

  input.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(splitter);
  merger.connect(glueComp);
  glueComp.connect(glueMakeup);
  glueMakeup.connect(limiterDrive);
  limiterDrive.connect(limiterComp);
  limiterComp.connect(limiterClipper);

  const activeGain = ctx.createGain();
  const bypassGain = ctx.createGain();
  const masterVol = ctx.createGain();

  activeGain.gain.value = m.enabled ? 1 : 0;
  bypassGain.gain.value = m.enabled ? 0 : 1;
  masterVol.gain.value = dbToGain(m.masterVolume);

  input.connect(bypassGain);
  bypassGain.connect(masterVol);
  limiterClipper.connect(activeGain);
  activeGain.connect(masterVol);

  return {
    input,
    output: masterVol,
    nodes: {
      eqLow, eqMid, eqHigh, sideWidthGain,
      glueComp, glueMakeup, limiterDrive, limiterComp, limiterClipper,
      activeGain, bypassGain, masterVol,
    },
  };
}

/**
 * Encode a Stereo AudioBuffer into a genuine MP3 Blob using lamejs.
 */
export async function encodeAudioBufferToMp3(audioBuffer, bitrateKbps = 192, onProgress = null) {
  const lame = window.lamejs;
  if (!lame || !lame.Mp3Encoder) {
    throw new Error('مكتبة ترميز MP3 (lamejs) غير محمّلة.');
  }

  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const encoder = new lame.Mp3Encoder(numChannels, sampleRate, bitrateKbps);

  const leftFloat = audioBuffer.getChannelData(0);
  const rightFloat = numChannels > 1 ? audioBuffer.getChannelData(1) : leftFloat;
  const totalSamples = leftFloat.length;

  const leftInt16 = new Int16Array(totalSamples);
  const rightInt16 = new Int16Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const l = clamp(leftFloat[i], -1, 1);
    const r = clamp(rightFloat[i], -1, 1);
    leftInt16[i] = l < 0 ? l * 0x8000 : l * 0x7fff;
    rightInt16[i] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }

  const blockSize = 1152;
  const mp3Chunks = [];
  const yieldInterval = 32;
  let blocksProcessed = 0;

  for (let i = 0; i < totalSamples; i += blockSize) {
    const end = Math.min(i + blockSize, totalSamples);
    const lChunk = leftInt16.subarray(i, end);
    const rChunk = rightInt16.subarray(i, end);

    const mp3buf = numChannels === 2
      ? encoder.encodeBuffer(lChunk, rChunk)
      : encoder.encodeBuffer(lChunk);

    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf));
    }

    blocksProcessed++;
    if (blocksProcessed % yieldInterval === 0) {
      if (onProgress) onProgress(Math.min(0.98, i / totalSamples));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const endBuf = encoder.flush();
  if (endBuf.length > 0) {
    mp3Chunks.push(new Uint8Array(endBuf));
  }

  if (onProgress) onProgress(1.0);
  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

/**
 * Encode a Stereo AudioBuffer into a 16-bit PCM WAV Blob.
 */
export function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = length * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  let offset = 44;
  for (let i = 0; i < length; i++) {
    const l = clamp(ch0[i], -1, 1);
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      const r = clamp(ch1[i], -1, 1);
      view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function normalizeBuffer(audioBuffer, targetPeakDb = -0.5) {
  let maxPeak = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > maxPeak) maxPeak = a;
    }
  }
  if (maxPeak < 0.0001) return;
  const scale = dbToGain(targetPeakDb) / maxPeak;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = clamp(data[i] * scale, -0.999, 0.999);
    }
  }
}

export function analyzeLoudness(audioBuffer) {
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 2) {
      const s = data[i];
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
      count++;
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, count));
  return {
    peakDb: gainToDb(peak),
    approxLufs: gainToDb(rms) - 0.691,
  };
}

/**
 * Synthesize a musical built-in backing track AudioBuffer.
 */
export async function synthesizeDemoBeat(beatId = 'oriental_groove') {
  const sr = 44100;
  const duration = 20;
  const off = new OfflineAudioContext(2, sr * duration, sr);

  const master = off.createGain();
  master.gain.value = 0.72;
  const rev = off.createConvolver();
  rev.buffer = createReverbIR(off, 'studio', 1.4);
  const revSend = off.createGain();
  revSend.gain.value = 0.24;

  master.connect(off.destination);
  revSend.connect(rev);
  rev.connect(off.destination);

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const playKick = (time, punch = 0.85) => {
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.14);
    g.gain.setValueAtTime(punch, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
    osc.connect(g); g.connect(master);
    osc.start(time); osc.stop(time + 0.3);
  };

  const playPerc = (time, freq = 950, decay = 0.09, gainVal = 0.25) => {
    const bufLen = Math.floor(sr * decay);
    const buf = off.createBuffer(1, bufLen, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * decay * 0.28));
    }
    const src = off.createBufferSource();
    src.buffer = buf;
    const bp = off.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 1.6;
    const g = off.createGain();
    g.gain.value = gainVal;
    src.connect(bp); bp.connect(g); g.connect(master); g.connect(revSend);
    src.start(time);
  };

  const playPluck = (time, midi, dur = 0.65, vol = 0.22, panVal = 0) => {
    const osc1 = off.createOscillator();
    const osc2 = off.createOscillator();
    osc1.type = 'triangle'; osc2.type = 'sawtooth';
    const f = midiToFreq(midi);
    osc1.frequency.setValueAtTime(f, time);
    osc2.frequency.setValueAtTime(f * 2, time);
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2800, time);
    lp.frequency.exponentialRampToValueAtTime(520, time + dur);
    const g = off.createGain();
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    const pan = off.createStereoPanner(); pan.pan.value = panVal;
    const mix2 = off.createGain(); mix2.gain.value = 0.28;
    osc1.connect(lp); osc2.connect(mix2); mix2.connect(lp);
    lp.connect(g); g.connect(pan); pan.connect(master); pan.connect(revSend);
    osc1.start(time); osc2.start(time);
    osc1.stop(time + dur + 0.05); osc2.stop(time + dur + 0.05);
  };

  const playPadChord = (time, midis, dur, vol = 0.14) => {
    midis.forEach((m, idx) => {
      const osc = off.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(m), time);
      osc.detune.value = idx % 2 === 0 ? -5 : 5;
      const lp = off.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1400;
      const g = off.createGain();
      g.gain.setValueAtTime(0.001, time);
      g.gain.linearRampToValueAtTime(vol / midis.length, time + 0.18);
      g.gain.setValueAtTime(vol / midis.length, time + dur - 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      const pan = off.createStereoPanner();
      pan.pan.value = (idx - (midis.length - 1) / 2) * 0.28;
      osc.connect(lp); lp.connect(g); g.connect(pan); pan.connect(master); pan.connect(revSend);
      osc.start(time); osc.stop(time + dur + 0.05);
    });
  };

  const playBass = (time, midi, dur, vol = 0.34) => {
    const osc = off.createOscillator();
    osc.type = 'sine'; osc.frequency.setValueAtTime(midiToFreq(midi), time);
    const oscSub = off.createOscillator();
    oscSub.type = 'triangle'; oscSub.frequency.setValueAtTime(midiToFreq(midi), time);
    const subLp = off.createBiquadFilter(); subLp.type = 'lowpass'; subLp.frequency.value = 320;
    const g = off.createGain();
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(g); oscSub.connect(subLp); subLp.connect(g); g.connect(master);
    osc.start(time); oscSub.start(time);
    osc.stop(time + dur + 0.04); oscSub.stop(time + dur + 0.04);
  };

  if (beatId === 'oriental_groove') {
    const bpm = 96;
    const step = 60 / bpm / 2;
    const chords = [
      { bass: 38, pad: [50, 54, 57, 62], arp: [62, 66, 67, 69, 67, 66, 63, 62] },
      { bass: 39, pad: [51, 55, 58, 63], arp: [63, 67, 70, 67, 66, 63, 62, 57] },
      { bass: 43, pad: [55, 58, 62, 67], arp: [67, 69, 70, 69, 67, 66, 63, 62] },
      { bass: 38, pad: [50, 54, 57, 62], arp: [62, 63, 66, 69, 66, 63, 62, 57] },
    ];
    let bar = 0;
    for (let t = 0; t < duration - 0.5; t += step * 8) {
      const c = chords[bar % chords.length];
      playPadChord(t, c.pad, step * 8, 0.24);
      playBass(t, c.bass, step * 3.5, 0.36);
      playBass(t + step * 4, c.bass, step * 3.5, 0.30);
      playKick(t, 0.85);
      playPerc(t + step * 1, 2200, 0.07, 0.24);
      playPerc(t + step * 3, 2400, 0.08, 0.22);
      playKick(t + step * 4, 0.78);
      playPerc(t + step * 6, 2100, 0.08, 0.26);
      playPerc(t + step * 7, 5200, 0.04, 0.14);
      c.arp.forEach((note, i) => {
        if (t + i * step < duration - 0.2) {
          playPluck(t + i * step, note, step * 1.9, 0.18, i % 2 === 0 ? -0.35 : 0.35);
        }
      });
      bar++;
    }
  } else if (beatId === 'lofi_chill') {
    const bpm = 82;
    const step = 60 / bpm / 2;
    const prog = [
      { bass: 45, pad: [57, 60, 64, 67] },
      { bass: 41, pad: [53, 57, 60, 64] },
      { bass: 48, pad: [55, 60, 64, 67] },
      { bass: 43, pad: [55, 59, 62, 67] },
    ];
    let bar = 0;
    for (let t = 0; t < duration - 0.5; t += step * 8) {
      const c = prog[bar % prog.length];
      playPadChord(t, c.pad, step * 7.8, 0.30);
      playBass(t, c.bass, step * 7.5, 0.36);
      playKick(t, 0.8);
      playKick(t + step * 3.5, 0.65);
      playPerc(t + step * 2, 1300, 0.12, 0.26);
      playPerc(t + step * 6, 1300, 0.12, 0.26);
      for (let i = 0; i < 8; i++) {
        playPerc(t + i * step, 6800, 0.035, i % 2 === 0 ? 0.10 : 0.06);
      }
      bar++;
    }
  } else {
    const bpm = 108;
    const step = 60 / bpm / 2;
    const prog = [
      { bass: 36, pad: [48, 55, 60, 63], arp: [60, 63, 67, 72] },
      { bass: 44, pad: [56, 60, 63, 68], arp: [63, 68, 72, 68] },
      { bass: 39, pad: [51, 55, 58, 63], arp: [58, 63, 67, 70] },
      { bass: 46, pad: [53, 58, 62, 65], arp: [58, 62, 65, 70] },
    ];
    let bar = 0;
    for (let t = 0; t < duration - 0.5; t += step * 8) {
      const c = prog[bar % prog.length];
      playPadChord(t, c.pad, step * 7.8, 0.28);
      playBass(t, c.bass, step * 3.8, 0.36);
      playBass(t + step * 4, c.bass, step * 3.8, 0.32);
      playKick(t, 0.88);
      playKick(t + step * 4, 0.82);
      playPerc(t + step * 2, 1600, 0.11, 0.28);
      playPerc(t + step * 6, 1600, 0.11, 0.28);
      for (let i = 0; i < 8; i++) {
        playPerc(t + i * step, 7400, 0.03, 0.08);
        playPluck(t + i * step, c.arp[i % c.arp.length], step * 1.6, 0.13, i % 2 === 0 ? -0.4 : 0.4);
      }
      bar++;
    }
  }

  return await off.startRendering();
}

/**
 * Main Studio Audio Engine managing live playback, recording, real-time FX,
 * precision metronome, harmony generation, metering, and offline MP3/WAV mixdown.
 */
export class StudioAudioEngine {
  constructor() {
    this.ctx = null;
    this.state = structuredClone(DEFAULT_MIX_STATE);

    // Loaded audio buffers
    this.backingBuffer = null;
    this.backingName = '';
    this.vocalTakes = [];
    this.activeTakeIndex = -1;
    this.gatedVocalBuffer = null;
    this._lastGateThresh = null;
    this._lastGatedTakeId = null;

    // Cached pitch-shifted harmony & Auto-Tune buffers
    this._harmonyCache = { key: '', buffer: null };
    this._autoTuneCache = { key: '', buffer: null, stats: null };
    this.lastAutoTuneStats = null;

    // Transport state
    this.isPlaying = false;
    this.isRecording = false;
    this.playheadSec = 0;
    this.playStartCtxTime = 0;
    this.playStartOffsetSec = 0;

    // Precision Metronome Scheduler
    this._metroTimer = null;
    this._metroNextBeatTime = 0;
    this._metroBeatIndex = 0;
    this.onMetronomeBeat = null; // (beatIndex, beatsPerBar) => void

    // Live graph references
    this._activeSources = [];
    this._backingGain = null;
    this._backingDuckGain = null;
    this._backingPan = null;
    this._vocalGain = null;
    this._vocalPan = null;
    this._vocalChain = null;
    this._masterChain = null;
    this._analyserL = null;
    this._analyserR = null;
    this._analyserFFT = null;
    this._reverbIRCache = { key: '', buffer: null };

    // Microphone & recording state
    this.micStream = null;
    this._micSource = null;
    this._micAnalyser = null;
    this._monitorGain = null;
    this._recorderNode = null;
    this._recordChunksL = [];
    this._recordStartTime = 0;
    this.liveMonitoring = false;
    this.recordPeakHistory = [];

    // EQ preview probe
    this._eqProbeCtx = null;
    this._eqProbeNodes = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  get activeVocalBuffer() {
    if (this.activeTakeIndex < 0 || this.activeTakeIndex >= this.vocalTakes.length) return null;
    return this.vocalTakes[this.activeTakeIndex].buffer;
  }

  getDuration() {
    const bDur = this.backingBuffer ? this.backingBuffer.duration + Math.max(0, this.state.backing.offsetSec) : 0;
    const vDur = this.activeVocalBuffer
      ? this.activeVocalBuffer.duration + Math.max(0, this.state.vocal.syncOffsetMs / 1000)
      : 0;
    return Math.max(bDur, vDur, 0);
  }

  getCurrentTime() {
    if (this.isPlaying && this.ctx) {
      const elapsed = this.ctx.currentTime - this.playStartCtxTime;
      return Math.max(0, this.playStartOffsetSec + elapsed);
    }
    if (this.isRecording && this.ctx) {
      const elapsed = this.ctx.currentTime - this._recordStartTime;
      return Math.max(0, this.playStartOffsetSec + elapsed);
    }
    return this.playheadSec;
  }

  // =========================================================================
  // Precision Live Metronome (Independent / Synchronized, Instantly Muteable)
  // =========================================================================
  setMetronomeEnabled(enabled) {
    this.state.metronome.enabled = !!enabled;
    if (this.state.metronome.enabled) {
      this._startMetronomeScheduler();
    } else {
      this._stopMetronomeScheduler();
    }
  }

  setMetronomeBpm(bpm) {
    this.state.metronome.bpm = clamp(Math.round(bpm), 50, 180);
  }

  setMetronomeBeatsPerBar(beats) {
    this.state.metronome.beatsPerBar = [3, 4, 6].includes(beats) ? beats : 4;
    this._metroBeatIndex = 0;
  }

  setMetronomeVolume(vol) {
    this.state.metronome.volume = clamp(vol, 0, 1);
  }

  _startMetronomeScheduler(alignTime = null) {
    const ctx = this.ensureContext();
    this._stopMetronomeScheduler();
    this._metroBeatIndex = 0;
    this._metroNextBeatTime = alignTime !== null ? alignTime : ctx.currentTime + 0.04;

    const scheduleAhead = 0.12;
    this._metroTimer = setInterval(() => {
      if (!this.state.metronome.enabled || !this.ctx) return;
      const now = this.ctx.currentTime;
      while (this._metroNextBeatTime < now + scheduleAhead) {
        const beat = this._metroBeatIndex;
        const beatsPerBar = this.state.metronome.beatsPerBar;
        const when = this._metroNextBeatTime;
        this._scheduleMetronomeClick(when, beat === 0);

        if (this.onMetronomeBeat) {
          const delayMs = Math.max(0, (when - now) * 1000);
          setTimeout(() => {
            if (this.state.metronome.enabled && this.onMetronomeBeat) {
              this.onMetronomeBeat(beat, beatsPerBar);
            }
          }, delayMs);
        }

        const beatDur = 60 / clamp(this.state.metronome.bpm, 50, 180);
        this._metroNextBeatTime += beatDur;
        this._metroBeatIndex = (this._metroBeatIndex + 1) % beatsPerBar;
      }
    }, 25);
  }

  _stopMetronomeScheduler() {
    if (this._metroTimer) {
      clearInterval(this._metroTimer);
      this._metroTimer = null;
    }
  }

  _scheduleMetronomeClick(time, accent = false) {
    if (!this.ctx) return;
    const vol = clamp(this.state.metronome.volume, 0, 1) * (accent ? 0.42 : 0.28);
    if (vol <= 0.001) return;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accent ? 1380 : 920, time);
    osc.frequency.exponentialRampToValueAtTime(accent ? 680 : 480, time + 0.032);
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.0008, time + 0.045);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  playMetronomeClick(accent = false) {
    const ctx = this.ensureContext();
    this._scheduleMetronomeClick(ctx.currentTime + 0.005, accent);
  }

  // =========================================================================
  // Track Loading & Buffer Management
  // =========================================================================
  setBackingBuffer(buffer, name) {
    this.backingBuffer = buffer;
    this.backingName = name || 'موسيقى مؤلَّفة';
    this.state.backing.muted = false;
    this.stop(true);
    return buffer;
  }

  clearBackingTrack() {
    this.backingBuffer = null;
    this.backingName = '';
    this.stop(true);
  }

  async loadBackingFile(file) {
    const ctx = this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return this.setBackingBuffer(decoded, file.name);
  }

  async loadDemoBeat(beatId, beatName) {
    this.ensureContext();
    const buffer = await synthesizeDemoBeat(beatId);
    return this.setBackingBuffer(buffer, beatName);
  }

  async loadVocalFile(file) {
    const ctx = this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return this.addVocalTake(decoded, file.name);
  }

  addVocalTake(buffer, name) {
    const id = 'take_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const takeName = name || `تسجيل غناء #${this.vocalTakes.length + 1}`;
    const take = { id, name: takeName, buffer, createdAt: new Date() };
    this.vocalTakes.push(take);
    this.activeTakeIndex = this.vocalTakes.length - 1;
    this._invalidateGatedVocal();
    return take;
  }

  selectVocalTake(index) {
    if (index >= 0 && index < this.vocalTakes.length) {
      this.activeTakeIndex = index;
      this._invalidateGatedVocal();
      if (this.isPlaying) {
        const t = this.getCurrentTime();
        this.stop();
        this.play(t);
      }
    }
  }

  deleteVocalTake(index) {
    if (index < 0 || index >= this.vocalTakes.length) return;
    this.vocalTakes.splice(index, 1);
    if (this.vocalTakes.length === 0) {
      this.activeTakeIndex = -1;
    } else {
      this.activeTakeIndex = Math.min(this.activeTakeIndex, this.vocalTakes.length - 1);
    }
    this._invalidateGatedVocal();
    if (this.isPlaying) this.stop();
  }

  _invalidateGatedVocal() {
    this.gatedVocalBuffer = null;
    this._lastGateThresh = null;
    this._lastGatedTakeId = null;
    this._harmonyCache = { key: '', buffer: null };
    this._autoTuneCache = { key: '', buffer: null, stats: null };
    this.lastAutoTuneStats = null;
  }

  _invalidateAutoTune() {
    this._autoTuneCache = { key: '', buffer: null, stats: null };
    this._harmonyCache = { key: '', buffer: null };
  }

  _getProcessedVocalBuffer(ctx) {
    const raw = this.activeVocalBuffer;
    if (!raw) return null;
    const takeId = this.vocalTakes[this.activeTakeIndex]?.id;
    const fx = this.state.vocalFx;
    const fxOn = this.state.vocal.fxEnabled;
    const thresh = fxOn ? fx.gateThreshold : -80;

    let gated = null;
    if (ctx === this.ctx && this.gatedVocalBuffer && this._lastGateThresh === thresh && this._lastGatedTakeId === takeId) {
      gated = this.gatedVocalBuffer;
    } else {
      gated = applyNoiseGate(ctx, raw, thresh);
      if (ctx === this.ctx) {
        this.gatedVocalBuffer = gated;
        this._lastGateThresh = thresh;
        this._lastGatedTakeId = takeId;
      }
    }

    if (!fxOn || !fx.autoTuneEnabled) {
      return gated;
    }

    const atKey = `${ctx.sampleRate}_${takeId}_${thresh}_${fx.autoTuneKey}_${fx.autoTuneScale}_${fx.autoTuneSpeed}_${fx.autoTuneAmount}`;
    if (ctx === this.ctx && this._autoTuneCache.key === atKey && this._autoTuneCache.buffer) {
      this.lastAutoTuneStats = this._autoTuneCache.stats;
      return this._autoTuneCache.buffer;
    }

    const result = applyAutoTuneToBuffer(ctx, gated, {
      key: Number(fx.autoTuneKey),
      scale: fx.autoTuneScale,
      retuneSpeed: Number(fx.autoTuneSpeed),
      strength: Number(fx.autoTuneAmount),
    });

    if (ctx === this.ctx && result) {
      this._autoTuneCache = { key: atKey, buffer: result.buffer, stats: result.stats };
      this.lastAutoTuneStats = result.stats;
    }
    return result ? result.buffer : gated;
  }

  computeAutoTunePreview() {
    if (!this.activeVocalBuffer || !this.state.vocal.fxEnabled || !this.state.vocalFx.autoTuneEnabled) {
      return null;
    }
    const ctx = this.ensureContext();
    this._getProcessedVocalBuffer(ctx);
    return this.lastAutoTuneStats;
  }

  _getHarmonyBuffer(ctx, vocalBuf) {
    if (!vocalBuf || !this.state.vocal.fxEnabled || !this.state.vocalFx.harmonyEnabled) return null;
    const fx = this.state.vocalFx;
    const semi = Number(fx.harmonyInterval) || 7;
    const takeId = this.vocalTakes[this.activeTakeIndex]?.id || 'v';
    const key = `${ctx.sampleRate}_${takeId}_${semi}_${fx.gateThreshold}_${fx.autoTuneEnabled}_${fx.autoTuneKey}_${fx.autoTuneScale}_${fx.autoTuneSpeed}_${fx.autoTuneAmount}`;
    if (ctx === this.ctx && this._harmonyCache.key === key && this._harmonyCache.buffer) {
      return this._harmonyCache.buffer;
    }
    const buf = createPitchShiftedHarmonyBuffer(ctx, vocalBuf, semi);
    if (ctx === this.ctx) {
      this._harmonyCache = { key, buffer: buf };
    }
    return buf;
  }

  _getReverbIR(ctx) {
    const fx = this.state.vocalFx;
    const key = `${ctx.sampleRate}_${fx.reverbType}_${fx.reverbDecay.toFixed(2)}`;
    if (ctx === this.ctx && this._reverbIRCache.key === key && this._reverbIRCache.buffer) {
      return this._reverbIRCache.buffer;
    }
    const buf = createReverbIR(ctx, fx.reverbType, fx.reverbDecay);
    if (ctx === this.ctx) {
      this._reverbIRCache = { key, buffer: buf };
    }
    return buf;
  }

  _effectiveTrackGains() {
    const b = this.state.backing;
    const v = this.state.vocal;
    const anySolo = b.solo || v.solo;
    const bActive = !b.muted && (!anySolo || b.solo);
    const vActive = !v.muted && (!anySolo || v.solo);
    return {
      backingGain: bActive ? dbToGain(b.volume) : 0,
      vocalGain: vActive ? dbToGain(v.volume) : 0,
    };
  }

  /**
   * Start real-time playback from `startSec`.
   */
  play(startSec = null) {
    if (!this.backingBuffer && !this.activeVocalBuffer) return false;
    const ctx = this.ensureContext();
    this.stop(false);

    const totalDur = this.getDuration();
    let offset = startSec !== null ? startSec : this.playheadSec;
    if (offset >= totalDur - 0.05) offset = 0;

    const now = ctx.currentTime + 0.025;
    this.playStartCtxTime = now;
    this.playStartOffsetSec = offset;
    this.isPlaying = true;

    // Align live metronome to playback start if enabled
    if (this.state.metronome.enabled) {
      this._startMetronomeScheduler(now);
    }

    // Master Bus + Analysers
    this._masterChain = buildMasterChain(ctx, this.state);

    const meterSplit = ctx.createChannelSplitter(2);
    this._analyserL = ctx.createAnalyser();
    this._analyserR = ctx.createAnalyser();
    this._analyserFFT = ctx.createAnalyser();
    this._analyserL.fftSize = 512;
    this._analyserR.fftSize = 512;
    this._analyserFFT.fftSize = 1024;
    this._analyserFFT.smoothingTimeConstant = 0.82;

    this._masterChain.output.connect(ctx.destination);
    this._masterChain.output.connect(this._analyserFFT);
    this._masterChain.output.connect(meterSplit);
    meterSplit.connect(this._analyserL, 0);
    meterSplit.connect(this._analyserR, 1);

    const { backingGain, vocalGain } = this._effectiveTrackGains();

    // 1. Backing Track Source
    if (this.backingBuffer) {
      const bSrc = ctx.createBufferSource();
      bSrc.buffer = this.backingBuffer;

      this._backingGain = ctx.createGain();
      this._backingGain.gain.value = backingGain;

      this._backingDuckGain = ctx.createGain();
      this._backingDuckGain.gain.value = 1.0;

      if (this.activeVocalBuffer && vocalGain > 0 && this.state.vocal.duckingDb > 0.05) {
        const syncSec = this.state.vocal.syncOffsetMs / 1000;
        const remaining = Math.max(0.2, totalDur - offset);
        const fullCurve = computeAutoDuckingCurve(
          this.activeVocalBuffer,
          this.state.vocal.duckingDb,
          totalDur,
          syncSec,
          0.05
        );
        const startIdx = Math.min(fullCurve.length - 2, Math.floor(offset / 0.05));
        const subCurve = fullCurve.subarray(startIdx);
        if (subCurve.length >= 2) {
          this._backingDuckGain.gain.setValueCurveAtTime(subCurve, now, remaining);
        }
      }

      this._backingPan = ctx.createStereoPanner();
      this._backingPan.pan.value = this.state.backing.pan;

      bSrc.connect(this._backingGain);
      this._backingGain.connect(this._backingDuckGain);
      this._backingDuckGain.connect(this._backingPan);
      this._backingPan.connect(this._masterChain.input);

      const trackStart = this.state.backing.offsetSec;
      if (offset >= trackStart) {
        const srcOffset = offset - trackStart;
        if (srcOffset < this.backingBuffer.duration) {
          bSrc.start(now, srcOffset);
          this._activeSources.push(bSrc);
        }
      } else {
        bSrc.start(now + (trackStart - offset), 0);
        this._activeSources.push(bSrc);
      }
    }

    // 2. Vocal Track Source + Full Vocal FX Chain + Optional Harmony Layer
    const vocalBuf = this._getProcessedVocalBuffer(ctx);
    if (vocalBuf) {
      const vSrc = ctx.createBufferSource();
      vSrc.buffer = vocalBuf;

      this._vocalChain = buildVocalFxChain(ctx, this.state, this._getReverbIR(ctx));
      this._vocalGain = ctx.createGain();
      this._vocalGain.gain.value = vocalGain;
      this._vocalPan = ctx.createStereoPanner();
      this._vocalPan.pan.value = this.state.vocal.pan;

      vSrc.connect(this._vocalChain.input);
      this._vocalChain.output.connect(this._vocalGain);
      this._vocalGain.connect(this._vocalPan);
      this._vocalPan.connect(this._masterChain.input);

      const syncSec = this.state.vocal.syncOffsetMs / 1000;
      const startSource = (src, buf) => {
        if (offset >= syncSec) {
          const srcOffset = offset - syncSec;
          if (srcOffset < buf.duration) {
            src.start(now, srcOffset);
            this._activeSources.push(src);
          }
        } else {
          src.start(now + (syncSec - offset), 0);
          this._activeSources.push(src);
        }
      };

      startSource(vSrc, vocalBuf);

      const harmonyBuf = this._getHarmonyBuffer(ctx, vocalBuf);
      if (harmonyBuf) {
        const hSrc = ctx.createBufferSource();
        hSrc.buffer = harmonyBuf;
        hSrc.connect(this._vocalChain.harmonyInput);
        startSource(hSrc, harmonyBuf);
      }
    }

    return true;
  }

  pause() {
    if (!this.isPlaying) return;
    this.playheadSec = this.getCurrentTime();
    this.stop(false);
  }

  stop(resetPlayhead = true) {
    this._activeSources.forEach((src) => {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    });
    this._activeSources = [];
    if (this._vocalChain) {
      this._vocalChain.stopOscillators();
      this._vocalChain = null;
    }
    this._masterChain = null;
    this._backingGain = null;
    this._backingDuckGain = null;
    this._backingPan = null;
    this._vocalGain = null;
    this._vocalPan = null;
    this.isPlaying = false;
    if (resetPlayhead) {
      this.playheadSec = 0;
    }
  }

  seek(sec) {
    const dur = this.getDuration();
    this.playheadSec = clamp(sec, 0, dur);
    if (this.isPlaying) {
      this.play(this.playheadSec);
    }
  }

  /**
   * Apply any real-time parameter updates smoothly to the currently playing Web Audio graph.
   */
  syncLiveParams(options = {}) {
    if (!this.ctx || !this.isPlaying) return;
    const now = this.ctx.currentTime;
    const smooth = 0.018;

    const { backingGain, vocalGain } = this._effectiveTrackGains();

    if (this._backingGain) {
      this._backingGain.gain.setTargetAtTime(backingGain, now, smooth);
    }
    if (this._backingPan) {
      this._backingPan.pan.setTargetAtTime(this.state.backing.pan, now, smooth);
    }
    if (this._vocalGain) {
      this._vocalGain.gain.setTargetAtTime(vocalGain, now, smooth);
    }
    if (this._vocalPan) {
      this._vocalPan.pan.setTargetAtTime(this.state.vocal.pan, now, smooth);
    }

    if (this._vocalChain) {
      const fx = this.state.vocalFx;
      const n = this._vocalChain.nodes;
      const eqOn = fx.eqEnabled !== false;

      n.hpf.frequency.setTargetAtTime(eqOn ? fx.hpfFreq : 20, now, smooth);
      n.eqLow.gain.setTargetAtTime(eqOn ? fx.eqLow : 0, now, smooth);
      n.eqWarmth.gain.setTargetAtTime(eqOn ? fx.eqWarmth : 0, now, smooth);
      n.eqPresence.gain.setTargetAtTime(eqOn ? fx.eqPresence : 0, now, smooth);
      n.eqAir.gain.setTargetAtTime(eqOn ? fx.eqAir : 0, now, smooth);
      n.deEsser.gain.setTargetAtTime(eqOn ? -(fx.deEsser / 100) * 11 : 0, now, smooth);

      if (options.warmthChanged || options.eqToggleChanged) {
        n.warmth.curve = createWarmthCurve(eqOn ? fx.warmth : 0);
      }

      // Overdrive
      const driveAmt = fx.driveEnabled ? clamp((fx.driveAmount || 0) / 100, 0, 1) * 0.72 : 0;
      n.driveWet.gain.setTargetAtTime(driveAmt, now, smooth);
      n.driveDry.gain.setTargetAtTime(1 - driveAmt * 0.55, now, smooth);
      if (options.driveChanged) {
        n.driveShaper.curve = createOverdriveCurve(fx.driveAmount || 0);
      }

      // Lo-Fi Radio / Telephone / Megaphone
      const lofiSpec = getLofiFilterSpec(fx.lofiStyle);
      n.lofiHp.frequency.setTargetAtTime(lofiSpec.hp, now, smooth);
      n.lofiLp.frequency.setTargetAtTime(lofiSpec.lp, now, smooth);
      n.lofiPeak.frequency.setTargetAtTime(lofiSpec.peakFreq, now, smooth);
      n.lofiPeak.Q.setTargetAtTime(lofiSpec.peakQ, now, smooth);
      n.lofiPeak.gain.setTargetAtTime(lofiSpec.peakGain, now, smooth);
      const lofiRatio = fx.lofiEnabled ? clamp((fx.lofiMix || 0) / 100, 0, 1) : 0;
      n.lofiWet.gain.setTargetAtTime(lofiRatio, now, smooth);
      n.lofiDry.gain.setTargetAtTime(1 - lofiRatio, now, smooth);

      // Compressor
      const compOn = fx.compEnabled !== false;
      n.comp.threshold.setTargetAtTime(fx.compThreshold, now, smooth);
      n.comp.ratio.setTargetAtTime(Math.max(1, fx.compRatio), now, smooth);
      n.comp.attack.setTargetAtTime(fx.compAttack / 1000, now, smooth);
      n.comp.release.setTargetAtTime(fx.compRelease / 1000, now, smooth);
      n.compMakeup.gain.setTargetAtTime(dbToGain(fx.compMakeup), now, smooth);
      n.compActiveGain.gain.setTargetAtTime(compOn ? 1 : 0, now, smooth);
      n.compBypassGain.gain.setTargetAtTime(compOn ? 0 : 1, now, smooth);

      // Flanger / Phaser Modulation
      n.modLfo.frequency.setTargetAtTime(fx.modRate || 0.6, now, smooth);
      n.flangerDepth.gain.setTargetAtTime(((fx.modDepth || 40) / 100) * 0.0045, now, smooth);
      n.phaserDepth.gain.setTargetAtTime(((fx.modDepth || 40) / 100) * 700, now, smooth);
      const modMixRatio = fx.modEnabled ? clamp((fx.modMix || 0) / 100, 0, 1) * 0.72 : 0;
      n.flangerWet.gain.setTargetAtTime(fx.modType === 'flanger' ? modMixRatio : 0, now, smooth);
      n.phaserWet.gain.setTargetAtTime(fx.modType === 'phaser' ? modMixRatio : 0, now, smooth);

      // Harmony mix
      n.harmonyInput.gain.setTargetAtTime(
        fx.harmonyEnabled ? clamp((fx.harmonyMix || 0) / 100, 0, 1) * 0.85 : 0,
        now,
        smooth
      );

      // Doubler, Reverb, Delay
      n.doublerWet.gain.setTargetAtTime((fx.doublerMix / 100) * 0.45, now, smooth);

      const revOn = fx.reverbEnabled !== false;
      n.revPreDelay.delayTime.setTargetAtTime(fx.reverbPreDelay / 1000, now, smooth);
      n.revWet.gain.setTargetAtTime(revOn ? (fx.reverbMix / 100) * 0.95 : 0, now, smooth);
      if (options.reverbIRChanged) {
        n.convolver.buffer = this._getReverbIR(this.ctx);
      }

      const delOn = fx.delayEnabled !== false;
      n.delayNode.delayTime.setTargetAtTime(fx.delayTimeMs / 1000, now, smooth);
      n.delayTone.frequency.setTargetAtTime(fx.delayToneHz, now, smooth);
      n.delayFeedback.gain.setTargetAtTime(clamp(fx.delayFeedback / 100, 0, 0.78), now, smooth);
      n.delayWet.gain.setTargetAtTime(delOn ? (fx.delayMix / 100) * 0.75 : 0, now, smooth);

      const en = this.state.vocal.fxEnabled;
      n.activeGain.gain.setTargetAtTime(en ? 1 : 0, now, smooth);
      n.bypassGain.gain.setTargetAtTime(en ? 0 : 1, now, smooth);
    }

    if (this._masterChain) {
      const m = this.state.master;
      const n = this._masterChain.nodes;
      n.eqLow.gain.setTargetAtTime(m.eqLow, now, smooth);
      n.eqMid.gain.setTargetAtTime(m.eqMid, now, smooth);
      n.eqHigh.gain.setTargetAtTime(m.eqHigh, now, smooth);
      n.sideWidthGain.gain.setTargetAtTime(m.stereoWidth / 100, now, smooth);
      n.glueComp.threshold.setTargetAtTime(-(m.glueAmount / 100) * 18, now, smooth);
      n.glueComp.ratio.setTargetAtTime(1 + (m.glueAmount / 100) * 2.5, now, smooth);
      n.glueMakeup.gain.setTargetAtTime(dbToGain((m.glueAmount / 100) * 2.2), now, smooth);
      n.limiterDrive.gain.setTargetAtTime(dbToGain(m.limiterDrive), now, smooth);
      n.limiterComp.threshold.setTargetAtTime(clamp(m.limiterCeiling - 1.5, -12, -0.5), now, smooth);
      if (options.ceilingChanged) {
        n.limiterClipper.curve = createLimiterClipperCurve(m.limiterCeiling);
      }
      n.activeGain.gain.setTargetAtTime(m.enabled ? 1 : 0, now, smooth);
      n.bypassGain.gain.setTargetAtTime(m.enabled ? 0 : 1, now, smooth);
      n.masterVol.gain.setTargetAtTime(dbToGain(m.masterVolume), now, smooth);
    }
  }

  /**
   * Initialize microphone stream for live input metering and studio vocal recording.
   */
  async initMicrophone(browserNoiseSuppression = false) {
    const ctx = this.ensureContext();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('المتصفح لا يدعم الوصول للميكروفون في هذا السياق.');
    }

    if (this.micStream) {
      this.releaseMicrophone();
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: browserNoiseSuppression,
        channelCount: 1,
      },
    });

    this._micSource = ctx.createMediaStreamSource(this.micStream);
    this._micAnalyser = ctx.createAnalyser();
    this._micAnalyser.fftSize = 512;

    this._monitorGain = ctx.createGain();
    this._monitorGain.gain.value = this.liveMonitoring ? 0.7 : 0;

    this._micSource.connect(this._micAnalyser);
    this._micSource.connect(this._monitorGain);
    this._monitorGain.connect(ctx.destination);

    return true;
  }

  setLiveMonitoring(enabled) {
    this.liveMonitoring = enabled;
    if (this._monitorGain && this.ctx) {
      this._monitorGain.gain.setTargetAtTime(enabled ? 0.72 : 0, this.ctx.currentTime, 0.02);
    }
  }

  releaseMicrophone() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    try { this._micSource?.disconnect(); } catch {}
    try { this._monitorGain?.disconnect(); } catch {}
    this._micSource = null;
    this._micAnalyser = null;
    this._monitorGain = null;
  }

  /**
   * Start synchronized vocal recording (works BOTH over backing music AND A Cappella!).
   */
  async startRecording(startSec = 0, { acapella = false } = {}) {
    const ctx = this.ensureContext();
    if (!this.micStream) {
      await this.initMicrophone(false);
    }
    this.stop(false);

    this._recordChunksL = [];
    this.recordPeakHistory = [];
    this.playStartOffsetSec = startSec;
    this.isRecording = true;

    const bufferSize = 2048;
    this._recorderNode = ctx.createScriptProcessor(bufferSize, 1, 1);
    const silentOut = ctx.createGain();
    silentOut.gain.value = 0;

    this._recorderNode.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      this._recordChunksL.push(copy);

      let peak = 0;
      for (let i = 0; i < inputData.length; i++) {
        const a = Math.abs(inputData[i]);
        if (a > peak) peak = a;
      }
      this.recordPeakHistory.push(peak);
    };

    this._micSource.connect(this._recorderNode);
    this._recorderNode.connect(silentOut);
    silentOut.connect(ctx.destination);

    const now = ctx.currentTime + 0.025;
    this._recordStartTime = now;

    // Align live metronome beat 1 to exact recording start if enabled
    if (this.state.metronome.enabled) {
      this._startMetronomeScheduler(now);
    }

    // Play backing track simultaneously unless A Cappella mode or muted
    if (!acapella && this.backingBuffer && !this.state.backing.muted) {
      const bSrc = ctx.createBufferSource();
      bSrc.buffer = this.backingBuffer;
      const bGain = ctx.createGain();
      bGain.gain.value = dbToGain(this.state.backing.volume);
      const bPan = ctx.createStereoPanner();
      bPan.pan.value = this.state.backing.pan;
      bSrc.connect(bGain);
      bGain.connect(bPan);
      bPan.connect(ctx.destination);

      const trackStart = this.state.backing.offsetSec;
      if (startSec >= trackStart) {
        const srcOff = startSec - trackStart;
        if (srcOff < this.backingBuffer.duration) {
          bSrc.start(now, srcOff);
          this._activeSources.push(bSrc);
        }
      } else {
        bSrc.start(now + (trackStart - startSec), 0);
        this._activeSources.push(bSrc);
      }
    }

    return true;
  }

  /**
   * Stop vocal recording and assemble the captured PCM into an AudioBuffer take.
   */
  stopRecording() {
    if (!this.isRecording) return null;
    this.isRecording = false;

    try { this._micSource?.disconnect(this._recorderNode); } catch {}
    try { this._recorderNode?.disconnect(); } catch {}
    this._recorderNode = null;

    this._activeSources.forEach((s) => { try { s.stop(); } catch {} });
    this._activeSources = [];

    const totalSamples = this._recordChunksL.reduce((acc, c) => acc + c.length, 0);
    if (totalSamples < 512) return null;

    const sr = this.ctx.sampleRate;
    const padSamples = Math.max(0, Math.floor(this.playStartOffsetSec * sr));
    const buf = this.ctx.createBuffer(2, padSamples + totalSamples, sr);
    const chL = buf.getChannelData(0);
    const chR = buf.getChannelData(1);

    let offset = padSamples;
    for (const chunk of this._recordChunksL) {
      chL.set(chunk, offset);
      chR.set(chunk, offset);
      offset += chunk.length;
    }

    this._recordChunksL = [];
    this.playheadSec = 0;
    return this.addVocalTake(buf);
  }

  getMeterData() {
    const readPeakRms = (analyser) => {
      if (!analyser) return { peak: 0, rms: 0 };
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        sumSq += buf[i] * buf[i];
      }
      return { peak, rms: Math.sqrt(sumSq / buf.length) };
    };

    const masterL = this.isPlaying ? readPeakRms(this._analyserL) : { peak: 0, rms: 0 };
    const masterR = this.isPlaying ? readPeakRms(this._analyserR) : { peak: 0, rms: 0 };
    const mic = readPeakRms(this._micAnalyser);

    let fft = null;
    if (this.isPlaying && this._analyserFFT) {
      fft = new Uint8Array(this._analyserFFT.frequencyBinCount);
      this._analyserFFT.getByteFrequencyData(fft);
    }

    const vocalCompGR = (this.isPlaying && this._vocalChain && this.state.vocalFx.compEnabled !== false)
      ? Math.abs(this._vocalChain.nodes.comp.reduction || 0)
      : 0;

    const masterGlueGR = (this.isPlaying && this._masterChain)
      ? Math.abs(this._masterChain.nodes.glueComp.reduction || 0)
      : 0;

    return {
      masterL,
      masterR,
      mic,
      fft,
      vocalCompGR,
      masterGlueGR,
    };
  }

  getVocalEqCurve(freqs) {
    if (!this._eqProbeCtx) {
      this._eqProbeCtx = new OfflineAudioContext(1, 64, 44100);
      const c = this._eqProbeCtx;
      this._eqProbeNodes = {
        hpf: Object.assign(c.createBiquadFilter(), { type: 'highpass' }),
        low: Object.assign(c.createBiquadFilter(), { type: 'lowshelf' }),
        warm: Object.assign(c.createBiquadFilter(), { type: 'peaking' }),
        pres: Object.assign(c.createBiquadFilter(), { type: 'peaking' }),
        air: Object.assign(c.createBiquadFilter(), { type: 'highshelf' }),
        deess: Object.assign(c.createBiquadFilter(), { type: 'peaking' }),
      };
      this._eqProbeNodes.hpf.Q.value = 0.707;
      this._eqProbeNodes.low.frequency.value = 100;
      this._eqProbeNodes.warm.frequency.value = 380;
      this._eqProbeNodes.warm.Q.value = 1.0;
      this._eqProbeNodes.pres.frequency.value = 3200;
      this._eqProbeNodes.pres.Q.value = 1.2;
      this._eqProbeNodes.air.frequency.value = 10000;
      this._eqProbeNodes.deess.frequency.value = 6800;
      this._eqProbeNodes.deess.Q.value = 2.8;
    }

    const fx = this.state.vocalFx;
    const eqOn = fx.eqEnabled !== false;
    const n = this._eqProbeNodes;
    n.hpf.frequency.value = eqOn ? fx.hpfFreq : 20;
    n.low.gain.value = eqOn ? fx.eqLow : 0;
    n.warm.gain.value = eqOn ? fx.eqWarmth : 0;
    n.pres.gain.value = eqOn ? fx.eqPresence : 0;
    n.air.gain.value = eqOn ? fx.eqAir : 0;
    n.deess.gain.value = eqOn ? -(fx.deEsser / 100) * 11 : 0;

    const totalDb = new Float32Array(freqs.length);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);

    for (const filter of Object.values(n)) {
      filter.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < freqs.length; i++) {
        totalDb[i] += 20 * Math.log10(Math.max(0.0001, mag[i]));
      }
    }
    return totalDb;
  }

  /**
   * Render the entire mix + vocal FX + harmony + mastering chain offline at 44.1 kHz Stereo
   * and encode to MP3 (via lamejs) or WAV. (Metronome is never included in exports.)
   */
  async exportMix({ format = 'mp3', bitrate = 192, normalize = true, onProgress = null } = {}) {
    if (!this.backingBuffer && !this.activeVocalBuffer) {
      throw new Error('أضف موسيقى أو سجّل صوت غناء أولاً قبل الاستخراج.');
    }

    const sampleRate = 44100;
    const baseDur = this.getDuration();
    const hasTail = this.activeVocalBuffer && this.state.vocal.fxEnabled &&
      ((this.state.vocalFx.reverbEnabled !== false && this.state.vocalFx.reverbMix > 0) ||
       (this.state.vocalFx.delayEnabled !== false && this.state.vocalFx.delayMix > 0));
    const tailSec = hasTail ? Math.min(3.5, this.state.vocalFx.reverbDecay + 0.6) : 0.3;
    const totalDuration = baseDur + tailSec;
    const totalLength = Math.ceil(totalDuration * sampleRate);

    if (onProgress) onProgress({ stage: 'rendering', percent: 8, message: 'جاري تطبيق الفلاتر والإيفكتات وعمل الميكس والماستر...' });

    const offCtx = new OfflineAudioContext(2, totalLength, sampleRate);
    const masterChain = buildMasterChain(offCtx, this.state);
    masterChain.output.connect(offCtx.destination);

    const { backingGain, vocalGain } = this._effectiveTrackGains();

    // 1. Backing Track
    if (this.backingBuffer && backingGain > 0) {
      const bSrc = offCtx.createBufferSource();
      bSrc.buffer = this.backingBuffer;

      const bGain = offCtx.createGain();
      bGain.gain.value = backingGain;

      const bDuck = offCtx.createGain();
      bDuck.gain.value = 1.0;
      if (this.activeVocalBuffer && vocalGain > 0 && this.state.vocal.duckingDb > 0.05) {
        const syncSec = this.state.vocal.syncOffsetMs / 1000;
        const curve = computeAutoDuckingCurve(
          this.activeVocalBuffer,
          this.state.vocal.duckingDb,
          totalDuration,
          syncSec,
          0.05
        );
        if (curve.length >= 2) {
          bDuck.gain.setValueCurveAtTime(curve, 0, totalDuration);
        }
      }

      const bPan = offCtx.createStereoPanner();
      bPan.pan.value = this.state.backing.pan;

      bSrc.connect(bGain);
      bGain.connect(bDuck);
      bDuck.connect(bPan);
      bPan.connect(masterChain.input);

      const bOffset = this.state.backing.offsetSec;
      if (bOffset >= 0) bSrc.start(bOffset, 0);
      else bSrc.start(0, -bOffset);
    }

    // 2. Vocal Track + Auto-Tune + All FX + Optional Harmony Layer
    if (this.activeVocalBuffer && vocalGain > 0) {
      let processedVocal = applyNoiseGate(
        offCtx,
        this.activeVocalBuffer,
        this.state.vocal.fxEnabled ? this.state.vocalFx.gateThreshold : -80
      );

      if (this.state.vocal.fxEnabled && this.state.vocalFx.autoTuneEnabled) {
        const fx = this.state.vocalFx;
        const tuned = applyAutoTuneToBuffer(offCtx, processedVocal, {
          key: Number(fx.autoTuneKey),
          scale: fx.autoTuneScale,
          retuneSpeed: Number(fx.autoTuneSpeed),
          strength: Number(fx.autoTuneAmount),
        });
        if (tuned && tuned.buffer) processedVocal = tuned.buffer;
      }

      const vSrc = offCtx.createBufferSource();
      vSrc.buffer = processedVocal;

      const ir = createReverbIR(offCtx, this.state.vocalFx.reverbType, this.state.vocalFx.reverbDecay);
      const vocalChain = buildVocalFxChain(offCtx, this.state, ir);

      const vGain = offCtx.createGain();
      vGain.gain.value = vocalGain;
      const vPan = offCtx.createStereoPanner();
      vPan.pan.value = this.state.vocal.pan;

      vSrc.connect(vocalChain.input);
      vocalChain.output.connect(vGain);
      vGain.connect(vPan);
      vPan.connect(masterChain.input);

      const syncSec = this.state.vocal.syncOffsetMs / 1000;
      if (syncSec >= 0) vSrc.start(syncSec, 0);
      else vSrc.start(0, -syncSec);

      if (this.state.vocal.fxEnabled && this.state.vocalFx.harmonyEnabled) {
        const hBuf = createPitchShiftedHarmonyBuffer(
          offCtx,
          processedVocal,
          Number(this.state.vocalFx.harmonyInterval) || 7
        );
        const hSrc = offCtx.createBufferSource();
        hSrc.buffer = hBuf;
        hSrc.connect(vocalChain.harmonyInput);
        if (syncSec >= 0) hSrc.start(syncSec, 0);
        else hSrc.start(0, -syncSec);
      }
    }

    const renderedBuffer = await offCtx.startRendering();

    if (normalize) {
      normalizeBuffer(renderedBuffer, clamp(this.state.master.limiterCeiling, -2.0, -0.2));
    }

    const stats = analyzeLoudness(renderedBuffer);

    if (onProgress) {
      onProgress({
        stage: 'encoding',
        percent: 45,
        message: format === 'mp3'
          ? `جاري الترميز إلى MP3 (${bitrate} kbps)...`
          : 'جاري تجهيز ملف WAV عالي الجودة...',
      });
    }

    let blob;
    if (format === 'mp3') {
      blob = await encodeAudioBufferToMp3(renderedBuffer, bitrate, (p) => {
        if (onProgress) {
          onProgress({
            stage: 'encoding',
            percent: Math.round(45 + p * 54),
            message: `جاري الترميز إلى MP3 (${bitrate} kbps) — ${Math.round(p * 100)}%`,
          });
        }
      });
    } else {
      blob = encodeAudioBufferToWav(renderedBuffer);
    }

    if (onProgress) {
      onProgress({ stage: 'done', percent: 100, message: 'تم الاستخراج بنجاح!' });
    }

    return {
      blob,
      url: URL.createObjectURL(blob),
      sizeBytes: blob.size,
      durationSec: renderedBuffer.duration,
      peakDb: stats.peakDb,
      approxLufs: stats.approxLufs,
      format,
      bitrate,
    };
  }
}
