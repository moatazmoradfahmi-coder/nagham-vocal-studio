/**
 * Nagham Studio — Main UI Controller & Application Orchestration
 * Includes: Multi-Track Recording, A Cappella Mode, Precision Metronome,
 * Creative Vocal FX & Harmony, Smart Auto-Composer, Mastering, and MP3 Export
 */

import { StudioAudioEngine, gainToDb, clamp } from './audio-engine.js';
import { VOCAL_PRESETS, MASTER_PRESETS, DEMO_BEATS } from './presets.js';
import { AUTOTUNE_SCALES } from './autotune.js';
import {
  NOTE_NAMES,
  NOTE_NAMES_AR,
  SCALES,
  CHORD_QUALITIES,
  RHYTHM_STYLES,
  RHYTHM_STEP_PRESETS,
  PLAY_STYLES,
  formatChordName,
  analyzeVocalAndComposeChords,
  buildDefaultProgression,
  renderComposedArrangement,
} from './auto-composer.js';
import {
  computeWaveformPeaks,
  drawWaveformTrack,
  drawEqCurve,
  drawAutoTuneGraph,
  drawSpectrum,
  StereoVuMeter,
} from './visualizers.js';

const engine = new StudioAudioEngine();
const topVu = new StereoVuMeter();
const masterVu = new StereoVuMeter();

let backingPeaks = null;
let vocalPeaks = null;
let activeVocalPresetId = 'clean_studio';
let activeMasterPresetId = 'balanced_commercial';
let countInCancelled = false;
let isCountingIn = false;
let lastExportUrl = null;
let restartDebounceTimer = null;
let lastRecordingWasAcapella = false;
let tapTimes = [];

// Smart Auto-Composer & FL 16-Step Sequencer State
let composedChords = buildDefaultProgression(2, 'hijaz', 8); // Default D Hijaz 8 bars
let detectedScaleId = 'hijaz';
let detectedRootPc = 2;
let flStepPattern = structuredClone(RHYTHM_STEP_PRESETS.maqsum);

const $ = (id) => document.getElementById(id);

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
}

function formatDb(v) {
  if (v <= -60) return '-∞ dB';
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
}

function formatPan(v) {
  if (Math.abs(v) < 0.04) return 'وسط';
  const pct = Math.round(Math.abs(v) * 100);
  return v < 0 ? `يسار ${pct}%` : `يمين ${pct}%`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showToast(message, type = 'info') {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s ease';
    setTimeout(() => el.remove(), 260);
  }, 4000);
}

// ==========================================================================
// Tab Switching, FL Window Dock, Browser Toggle & FL Hint LCD
// ==========================================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-dock-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dockTab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
  if (tabName === 'vocal-fx') {
    requestAnimationFrame(() => drawEqCurve($('eqCurveCanvas'), engine));
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelectorAll('[data-dock-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.dockTab);
    document.querySelector('.workbench-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

$('btnToggleBrowser').addEventListener('click', () => {
  const ws = document.querySelector('.fl-workspace');
  const collapsed = ws.classList.toggle('browser-collapsed');
  $('btnToggleBrowser').classList.toggle('active', !collapsed);
});

// Classic FL Studio dynamic Hint LCD on hover
const defaultHint = 'جاهز • اختر موسيقى أو اضغط «أكابيلا» للغناء بدون موسيقى وتأليف كوردات وإيقاع تلقائياً';
document.addEventListener('pointerover', (e) => {
  const target = e.target.closest?.('[data-hint], [title]');
  const hint = target?.getAttribute('data-hint') || target?.getAttribute('title');
  if (hint && $('flHintText')) {
    $('flHintText').textContent = hint;
  }
});
document.addEventListener('pointerout', (e) => {
  if (!e.relatedTarget && $('flHintText')) {
    $('flHintText').textContent = defaultHint;
  }
});

$('btnQuickExport').addEventListener('click', () => {
  switchTab('export');
  $('panel-export').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('btnOpenComposerFromTrack').addEventListener('click', () => {
  switchTab('composer');
  $('panel-composer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ==========================================================================
// Live Metronome Controls (Toggle/Mute, BPM, Tap Tempo, Time Sig, Volume)
// ==========================================================================
function renderMetronomeLeds(beatsPerBar, activeIdx = -1) {
  const wrap = $('metroBeatLeds');
  if (wrap.children.length !== beatsPerBar) {
    wrap.innerHTML = '';
    for (let i = 0; i < beatsPerBar; i++) {
      const dot = document.createElement('span');
      dot.className = 'beat-led';
      wrap.appendChild(dot);
    }
  }
  Array.from(wrap.children).forEach((dot, idx) => {
    dot.classList.remove('lit', 'lit-accent');
    if (idx === activeIdx) {
      dot.classList.add(idx === 0 ? 'lit-accent' : 'lit');
    }
  });
}

function updateMetronomeUI() {
  const m = engine.state.metronome;
  const btn = $('btnMetronomeToggle');
  btn.classList.toggle('active', m.enabled);
  $('metroToggleLabel').textContent = m.enabled ? 'المترونوم: شغّال' : 'المترونوم: مكتوم';
  $('inpBpm').value = m.bpm;
  $('selTimeSig').value = String(m.beatsPerBar);
  $('rngMetroVol').value = Math.round(m.volume * 100);
  $('valMetroVol').textContent = `${Math.round(m.volume * 100)}%`;
  $('compBpmMirror').textContent = `${m.bpm} BPM`;
  if (!m.enabled) renderMetronomeLeds(m.beatsPerBar, -1);
}

engine.onMetronomeBeat = (beatIdx, beatsPerBar) => {
  renderMetronomeLeds(beatsPerBar, beatIdx);
  setTimeout(() => {
    if (!engine.state.metronome.enabled) renderMetronomeLeds(beatsPerBar, -1);
  }, 140);
};

$('btnMetronomeToggle').addEventListener('click', () => {
  engine.setMetronomeEnabled(!engine.state.metronome.enabled);
  updateMetronomeUI();
});

function setBpmValue(val) {
  const clean = clamp(Math.round(Number(val) || 100), 50, 180);
  engine.setMetronomeBpm(clean);
  updateMetronomeUI();
}

$('inpBpm').addEventListener('change', (e) => setBpmValue(e.target.value));
$('btnBpmDown').addEventListener('click', () => setBpmValue(engine.state.metronome.bpm - 2));
$('btnBpmUp').addEventListener('click', () => setBpmValue(engine.state.metronome.bpm + 2));

$('btnTapTempo').addEventListener('click', () => {
  const now = performance.now();
  if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > 2200) {
    tapTimes = [];
  }
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();
  if (tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    const avgMs = sum / (tapTimes.length - 1);
    const bpm = Math.round(60000 / avgMs);
    setBpmValue(bpm);
  }
  engine.playMetronomeClick(tapTimes.length === 1);
});

$('selTimeSig').addEventListener('change', (e) => {
  const beats = parseInt(e.target.value, 10) || 4;
  engine.setMetronomeBeatsPerBar(beats);
  renderMetronomeLeds(beats, -1);
  updateMetronomeUI();
});

$('rngMetroVol').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value, 10) || 0;
  engine.setMetronomeVolume(pct / 100);
  $('valMetroVol').textContent = `${pct}%`;
});

// ==========================================================================
// Populate Demo Beats, Presets & Smart Auto-Composer UI
// ==========================================================================
function initDemoBeatsAndPresets() {
  const demoSel = $('selectDemoBeat');
  const browserBeats = $('flBrowserBeats');
  DEMO_BEATS.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.name} (${b.bpm} BPM)`;
    demoSel.appendChild(opt);

    const bBtn = document.createElement('button');
    bBtn.type = 'button';
    bBtn.className = 'fl-tree-item';
    bBtn.textContent = `${b.name} (${b.bpm} BPM)`;
    bBtn.addEventListener('click', () => {
      demoSel.value = b.id;
      demoSel.dispatchEvent(new Event('change'));
    });
    browserBeats.appendChild(bBtn);
  });

  const vocalGrid = $('vocalPresetsGrid');
  const browserPresets = $('flBrowserPresets');
  VOCAL_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `preset-chip ${p.id === activeVocalPresetId ? 'active' : ''}`;
    btn.dataset.presetId = p.id;
    btn.title = p.description;
    btn.textContent = p.name;
    btn.addEventListener('click', () => applyVocalPreset(p));
    vocalGrid.appendChild(btn);

    const tBtn = document.createElement('button');
    tBtn.type = 'button';
    tBtn.className = `fl-tree-item ${p.id === activeVocalPresetId ? 'active' : ''}`;
    tBtn.dataset.browserPresetId = p.id;
    tBtn.title = p.description;
    tBtn.textContent = p.name;
    tBtn.addEventListener('click', () => {
      applyVocalPreset(p);
      switchTab('vocal-fx');
    });
    browserPresets.appendChild(tBtn);
  });

  const masterGrid = $('masterPresetsGrid');
  const browserMasters = $('flBrowserMasters');
  MASTER_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `preset-chip ${p.id === activeMasterPresetId ? 'active' : ''}`;
    btn.dataset.masterId = p.id;
    btn.textContent = p.name;
    btn.addEventListener('click', () => applyMasterPreset(p));
    masterGrid.appendChild(btn);

    const mBtn = document.createElement('button');
    mBtn.type = 'button';
    mBtn.className = `fl-tree-item ${p.id === activeMasterPresetId ? 'active' : ''}`;
    mBtn.dataset.browserMasterId = p.id;
    mBtn.textContent = p.name;
    mBtn.addEventListener('click', () => {
      applyMasterPreset(p);
      switchTab('mastering');
    });
    browserMasters.appendChild(mBtn);
  });

  // FL Browser Auto-Tune quick shortcuts
  document.querySelectorAll('[data-browser-at]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.browserAt;
      if (mode === 'natural') $('btnAtModeNatural').click();
      else if (mode === 'pop') $('btnAtModePop').click();
      else if (mode === 'hard') $('btnAtModeHard').click();
      else toggleAutoTune(false);
      switchTab('vocal-fx');
    });
  });

  // Populate Auto-Composer & Auto-Tune Key selects
  const rootSel = $('compRootSelect');
  const atKeySel = $('fxAutoTuneKey');
  NOTE_NAMES_AR.forEach((label, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = label;
    rootSel.appendChild(opt);

    const opt2 = document.createElement('option');
    opt2.value = String(idx);
    opt2.textContent = label;
    atKeySel.appendChild(opt2);
  });

  const playStyleSel = $('compPlayStyle');
  PLAY_STYLES.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    playStyleSel.appendChild(opt);
  });

  const rhythmSel = $('compRhythmSelect');
  RHYTHM_STYLES.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === 'maqsum') opt.selected = true;
    rhythmSel.appendChild(opt);
  });

  rhythmSel.addEventListener('change', (e) => {
    const preset = RHYTHM_STEP_PRESETS[e.target.value] || RHYTHM_STEP_PRESETS.none;
    flStepPattern = structuredClone(preset);
    renderStepSequencer();
  });

  $('btnResetSteps').addEventListener('click', () => {
    const preset = RHYTHM_STEP_PRESETS[rhythmSel.value] || RHYTHM_STEP_PRESETS.maqsum;
    flStepPattern = structuredClone(preset);
    renderStepSequencer();
  });

  $('btnClearSteps').addEventListener('click', () => {
    flStepPattern = structuredClone(RHYTHM_STEP_PRESETS.none);
    renderStepSequencer();
  });

  renderStepSequencer();
  renderChordsGrid();
}

function renderStepSequencer() {
  const grid = $('flStepSequencerGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const rows = [
    { key: 'kick',  label: 'Doum / Kick',  cls: 'kick-ch' },
    { key: 'snare', label: 'Snare / Clap', cls: 'snare-ch' },
    { key: 'perc',  label: 'Tek / Perc',   cls: 'perc-ch' },
    { key: 'hat',   label: 'Hi-Hat / Riq', cls: 'hat-ch' },
  ];

  rows.forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'fl-seq-row';

    const ch = document.createElement('div');
    ch.className = `fl-seq-channel ${row.cls}`;
    ch.innerHTML = `<span>${row.label}</span>`;
    rowEl.appendChild(ch);

    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'fl-seq-steps';

    for (let i = 0; i < 16; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      const isGroupB = Math.floor(i / 4) % 2 === 1;
      const isActive = !!flStepPattern[row.key]?.[i];
      cell.className = `fl-step-cell ${isGroupB ? 'group-b' : ''} ${isActive ? 'active' : ''}`;
      cell.title = `${row.label} — خطوة ${i + 1}`;
      cell.addEventListener('click', () => {
        flStepPattern[row.key][i] = flStepPattern[row.key][i] ? 0 : 1;
        cell.classList.toggle('active', !!flStepPattern[row.key][i]);
      });
      stepsWrap.appendChild(cell);
    }

    rowEl.appendChild(stepsWrap);
    grid.appendChild(rowEl);
  });
}

function applyVocalPreset(preset) {
  activeVocalPresetId = preset.id;
  const needsRestart =
    engine.state.vocalFx.harmonyEnabled !== preset.fx.harmonyEnabled ||
    engine.state.vocalFx.harmonyInterval !== preset.fx.harmonyInterval ||
    engine.state.vocalFx.autoTuneEnabled !== preset.fx.autoTuneEnabled ||
    engine.state.vocalFx.autoTuneSpeed !== preset.fx.autoTuneSpeed ||
    engine.state.vocalFx.autoTuneAmount !== preset.fx.autoTuneAmount;

  Object.assign(engine.state.vocalFx, preset.fx);
  engine.state.vocal.fxEnabled = preset.id !== 'flat_raw';
  engine._invalidateGatedVocal();

  document.querySelectorAll('#vocalPresetsGrid .preset-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.presetId === preset.id);
  });
  document.querySelectorAll('[data-browser-preset-id]').forEach((b) => {
    b.classList.toggle('active', b.dataset.browserPresetId === preset.id);
  });

  syncControlsFromState();
  engine.syncLiveParams({ reverbIRChanged: true, warmthChanged: true, driveChanged: true, eqToggleChanged: true });
  refreshAutoTunePreview();
  if (needsRestart) schedulePlaybackRefresh();
  drawEqCurve($('eqCurveCanvas'), engine);
  showToast(`تم تطبيق قالب الصوت: ${preset.name}`, 'success');
}

function applyMasterPreset(preset) {
  activeMasterPresetId = preset.id;
  Object.assign(engine.state.master, preset.master);

  document.querySelectorAll('#masterPresetsGrid .preset-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.masterId === preset.id);
  });
  document.querySelectorAll('[data-browser-master-id]').forEach((b) => {
    b.classList.toggle('active', b.dataset.browserMasterId === preset.id);
  });

  syncControlsFromState();
  engine.syncLiveParams({ ceilingChanged: true });
  showToast(`تم تطبيق قالب الماستر: ${preset.name}`, 'success');
}

// ==========================================================================
// Smart Auto-Composer Logic (Analyze Vocal -> Chords -> Instruments + Rhythm)
// ==========================================================================
function renderChordsGrid() {
  const grid = $('chordsTimelineGrid');
  grid.innerHTML = '';

  const qualityEntries = Object.entries(CHORD_QUALITIES);

  composedChords.forEach((chord, idx) => {
    const card = document.createElement('div');
    card.className = 'chord-card';

    const top = document.createElement('div');
    top.className = 'chord-card-top';
    top.innerHTML = `<span>مازورة ${idx + 1}</span>`;

    const nameEl = document.createElement('div');
    nameEl.className = 'chord-card-name';
    nameEl.textContent = formatChordName(chord.rootPc, chord.quality);

    const selects = document.createElement('div');
    selects.className = 'chord-card-selects';

    const selRoot = document.createElement('select');
    selRoot.className = 'studio-select';
    NOTE_NAMES.forEach((n, pc) => {
      const opt = document.createElement('option');
      opt.value = String(pc);
      opt.textContent = n;
      if (pc === chord.rootPc) opt.selected = true;
      selRoot.appendChild(opt);
    });
    selRoot.addEventListener('change', (e) => {
      chord.rootPc = parseInt(e.target.value, 10);
      chord.name = formatChordName(chord.rootPc, chord.quality);
      nameEl.textContent = chord.name;
    });

    const selQual = document.createElement('select');
    selQual.className = 'studio-select';
    qualityEntries.forEach(([qKey, qObj]) => {
      const opt = document.createElement('option');
      opt.value = qKey;
      opt.textContent = qObj.suffix || 'maj';
      if (qKey === chord.quality) opt.selected = true;
      selQual.appendChild(opt);
    });
    selQual.addEventListener('change', (e) => {
      chord.quality = e.target.value;
      chord.name = formatChordName(chord.rootPc, chord.quality);
      nameEl.textContent = chord.name;
    });

    selects.appendChild(selRoot);
    selects.appendChild(selQual);
    card.appendChild(top);
    card.appendChild(nameEl);
    card.appendChild(selects);
    grid.appendChild(card);
  });
}

function getComposerInstrumentsConfig() {
  return {
    piano:   { enabled: $('instPianoOn').checked,   volume: Number($('instPianoVol').value) / 100 },
    guitar:  { enabled: $('instGuitarOn').checked,  volume: Number($('instGuitarVol').value) / 100 },
    oud:     { enabled: $('instOudOn').checked,     volume: Number($('instOudVol').value) / 100 },
    strings: { enabled: $('instStringsOn').checked, volume: Number($('instStringsVol').value) / 100 },
    bass:    { enabled: $('instBassOn').checked,    volume: Number($('instBassVol').value) / 100 },
    synth:   { enabled: $('instSynthOn').checked,   volume: Number($('instSynthVol').value) / 100 },
  };
}

// Instrument volume live labels
[
  ['instPianoVol', 'valInstPiano'],
  ['instGuitarVol', 'valInstGuitar'],
  ['instOudVol', 'valInstOud'],
  ['instStringsVol', 'valInstStrings'],
  ['instBassVol', 'valInstBass'],
  ['instSynthVol', 'valInstSynth'],
  ['compRhythmVol', 'valCompRhythmVol'],
].forEach(([rngId, valId]) => {
  $(rngId).addEventListener('input', (e) => {
    $(valId).textContent = `${e.target.value}%`;
  });
});

$('btnRebuildDefaultChords').addEventListener('click', () => {
  const rootSelVal = parseInt($('compRootSelect').value, 10);
  const scaleSelVal = $('compScaleSelect').value;
  const numBars = parseInt($('compNumBars').value, 10) || 8;
  const root = rootSelVal >= 0 ? rootSelVal : detectedRootPc;
  const scaleId = scaleSelVal !== 'auto' ? scaleSelVal : detectedScaleId;

  composedChords = buildDefaultProgression(root, scaleId, numBars);
  renderChordsGrid();
  const sName = SCALES[scaleId]?.name || scaleId;
  $('detectedKeyBadge').textContent = `المقام المختار: ${NOTE_NAMES_AR[root]} • ${sName}`;
  showToast('تم تحديث خريطة الكوردات حسب المقام المختار.', 'info');
});

function runVocalAnalysis() {
  if (!engine.activeVocalBuffer) {
    showToast('سجّل صوت غناء أولاً (بزر «غناء بدون موسيقى») أو اختر المقام يدوياً واضغط «توليد التوزيع».', 'info');
    return false;
  }

  const preferredRoot = parseInt($('compRootSelect').value, 10);
  const preferredScaleId = $('compScaleSelect').value;
  const res = analyzeVocalAndComposeChords(engine.activeVocalBuffer, {
    bpm: engine.state.metronome.bpm,
    beatsPerBar: engine.state.metronome.beatsPerBar,
    preferredScaleId,
    preferredRoot,
  });

  detectedRootPc = res.rootPc;
  detectedScaleId = res.scaleId;
  composedChords = res.chords;
  renderChordsGrid();

  const scaleLabel = SCALES[res.scaleId]?.name || res.scaleId;
  const confPct = Math.round(res.confidence * 100);
  $('detectedKeyBadge').textContent = res.voicedFrames >= 4
    ? `تم الاكتشاف: ${NOTE_NAMES_AR[res.rootPc]} • ${scaleLabel} (تطابق ${confPct}%)`
    : `تأليف افتراضي: ${NOTE_NAMES_AR[res.rootPc]} • ${scaleLabel}`;

  showToast(`تم تحليل غنائك وتأليف ${res.chords.length} مازورة كوردات على ${NOTE_NAMES_AR[res.rootPc]} (${scaleLabel})!`, 'success');
  return true;
}

$('btnAnalyzeVocal').addEventListener('click', () => {
  runVocalAnalysis();
});

async function handleGenerateArrangement() {
  const instruments = getComposerInstrumentsConfig();
  const rhythmStyle = $('compRhythmSelect').value;
  const rhythmVolume = Number($('compRhythmVol').value) / 100;
  const playStyle = $('compPlayStyle').value;

  const anyInst = Object.values(instruments).some((i) => i.enabled && i.volume > 0.01);
  const anyDrumStep = Object.values(flStepPattern).some((row) => row.some(Boolean));
  if (!anyInst && !anyDrumStep) {
    showToast('اختر آلة موسيقية واحدة على الأقل أو فعّل خطوات في سيكوينسر الإيقاع!', 'error');
    return;
  }

  // If user recorded vocals and hasn't analyzed yet, auto-analyze first to match length & key!
  if (engine.activeVocalBuffer && $('compRootSelect').value === '-1' && $('compScaleSelect').value === 'auto') {
    const barSec = (60 / engine.state.metronome.bpm) * engine.state.metronome.beatsPerBar;
    const neededBars = Math.max(4, Math.ceil(engine.activeVocalBuffer.duration / barSec));
    if (composedChords.length !== neededBars) {
      runVocalAnalysis();
    }
  }

  const btn1 = $('btnGenerateArrangement');
  const btn2 = $('btnGenerateArrangementBottom');
  btn1.disabled = true;
  btn2.disabled = true;
  showToast('جاري تأليف وعزف الآلات والإيقاع بدقة استوديو...', 'info');

  try {
    engine.ensureContext();
    const buf = await renderComposedArrangement({
      chords: composedChords,
      bpm: engine.state.metronome.bpm,
      beatsPerBar: engine.state.metronome.beatsPerBar,
      playStyle,
      rhythmStyle,
      rhythmVolume,
      customStepPattern: flStepPattern,
      instruments,
    });

    const scaleName = SCALES[detectedScaleId]?.name || '';
    const title = `توزيع مؤلَّف (${NOTE_NAMES[detectedRootPc]} ${scaleName} • ${engine.state.metronome.bpm} BPM)`;
    engine.setBackingBuffer(buf, title);
    backingPeaks = computeWaveformPeaks(buf, 650);
    $('backingFileName').textContent = `${title} — ${formatTime(buf.duration)}`;
    $('btnClearBacking').classList.remove('hidden');
    $('selectDemoBeat').value = '';
    updateTransportUI();

    showToast('تم تأليف وتوليد التوزيع الموسيقي بنجاح! اضغط تشغيل للاستماع مع غنائك.', 'success');
  } catch (err) {
    console.error(err);
    showToast(`تعذّر توليد التوزيع: ${err.message}`, 'error');
  } finally {
    btn1.disabled = false;
    btn2.disabled = false;
  }
}

$('btnGenerateArrangement').addEventListener('click', handleGenerateArrangement);
$('btnGenerateArrangementBottom').addEventListener('click', handleGenerateArrangement);

// ==========================================================================
// Track Loading (File Upload, Drag & Drop, Demo Beats, Clear Backing)
// ==========================================================================
async function handleBackingLoad(file) {
  try {
    showToast('جاري تحميل ومعالجة ملف الموسيقى...', 'info');
    const buf = await engine.loadBackingFile(file);
    backingPeaks = computeWaveformPeaks(buf, 650);
    $('backingFileName').textContent = `${file.name} (${formatTime(buf.duration)})`;
    $('btnClearBacking').classList.remove('hidden');
    $('selectDemoBeat').value = '';
    updateTransportUI();
    showToast('تم إضافة الموسيقى الخلفية بنجاح!', 'success');
  } catch (err) {
    console.error(err);
    showToast('تعذّر قراءة ملف الصوت. تأكد أنه بصيغة MP3 أو WAV أو M4A.', 'error');
  }
}

async function handleVocalLoad(file) {
  try {
    showToast('جاري استيراد ملف صوت الغناء...', 'info');
    const take = await engine.loadVocalFile(file);
    refreshVocalTakesUI();
    vocalPeaks = computeWaveformPeaks(take.buffer, 650);
    updateTransportUI();
    showToast('تم استيراد صوت الغناء بنجاح!', 'success');
  } catch (err) {
    console.error(err);
    showToast('تعذّر قراءة ملف صوت الغناء.', 'error');
  }
}

$('btnClearBacking').addEventListener('click', () => {
  engine.clearBackingTrack();
  backingPeaks = null;
  $('backingFileName').textContent = 'لا توجد موسيقى — يمكنك الغناء بدون موسيقى وتأليف كوردات تلقائياً';
  $('btnClearBacking').classList.add('hidden');
  $('selectDemoBeat').value = '';
  updateTransportUI();
  showToast('تم مسح الموسيقى الخلفية — يمكنك الآن الغناء بدون موسيقى.', 'info');
});

$('btnUploadBacking').addEventListener('click', () => $('backingFileInput').click());
$('backingFileInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleBackingLoad(file);
  e.target.value = '';
});

$('btnUploadVocal').addEventListener('click', () => $('vocalFileInput').click());
$('vocalFileInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleVocalLoad(file);
  e.target.value = '';
});

$('selectDemoBeat').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) return;
  const info = DEMO_BEATS.find((b) => b.id === id);
  try {
    showToast(`جاري توليد ${info.name}...`, 'info');
    const buf = await engine.loadDemoBeat(id, info.name);
    backingPeaks = computeWaveformPeaks(buf, 650);
    $('backingFileName').textContent = `إيقاع مدمج: ${info.name} (${formatTime(buf.duration)})`;
    $('btnClearBacking').classList.remove('hidden');
    setBpmValue(info.bpm);
    updateTransportUI();
    showToast(`تم تجهيز ${info.name} — اضغط تشغيل أو ابدأ تسجيل غنائك!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('حدث خطأ أثناء توليد الإيقاع التجريبي.', 'error');
  }
});

document.querySelectorAll('[data-dropzone]').forEach((zone) => {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (zone.dataset.dropzone === 'backing') handleBackingLoad(file);
    else handleVocalLoad(file);
  });
});

function refreshVocalTakesUI() {
  const sel = $('selectVocalTake');
  sel.innerHTML = '';
  if (engine.vocalTakes.length === 0) {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = 'لا توجد تسجيلات بعد';
    sel.appendChild(opt);
    $('btnDeleteTake').disabled = true;
    vocalPeaks = null;
    return;
  }
  engine.vocalTakes.forEach((take, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${take.name} (${formatTime(take.buffer.duration)})`;
    if (idx === engine.activeTakeIndex) opt.selected = true;
    sel.appendChild(opt);
  });
  $('btnDeleteTake').disabled = false;
  if (engine.activeVocalBuffer) {
    vocalPeaks = computeWaveformPeaks(engine.activeVocalBuffer, 650);
  }
  refreshAutoTunePreview();
}

$('selectVocalTake').addEventListener('change', (e) => {
  const idx = parseInt(e.target.value, 10);
  engine.selectVocalTake(idx);
  if (engine.activeVocalBuffer) {
    vocalPeaks = computeWaveformPeaks(engine.activeVocalBuffer, 650);
  }
  refreshAutoTunePreview();
});

$('btnDeleteTake').addEventListener('click', () => {
  if (engine.activeTakeIndex < 0) return;
  engine.deleteVocalTake(engine.activeTakeIndex);
  refreshVocalTakesUI();
  updateTransportUI();
  showToast('تم حذف التسجيل.', 'info');
});

// ==========================================================================
// Transport & Synchronized / A Cappella Vocal Recording
// ==========================================================================
function updateTransportUI() {
  const playing = engine.isPlaying;
  const recording = engine.isRecording;

  $('btnPlayPause').classList.toggle('playing', playing);
  $('iconPlay').classList.toggle('hidden', playing);
  $('iconPause').classList.toggle('hidden', !playing);
  $('playBtnLabel').textContent = playing ? 'إيقاف مؤقت' : 'تشغيل';

  $('btnRecord').classList.toggle('recording', recording);
  $('recBtnLabel').textContent = recording ? 'إنهاء التسجيل' : 'تسجيل غناء';

  $('timeTotal').textContent = formatTime(engine.getDuration());
  $('timeCurrent').textContent = formatTime(engine.getCurrentTime());
}

$('btnPlayPause').addEventListener('click', () => {
  if (engine.isRecording) return;
  if (engine.isPlaying) {
    engine.pause();
  } else {
    if (!engine.backingBuffer && !engine.activeVocalBuffer) {
      showToast('سجّل غناءك أو أضف موسيقى أو ألّف كوردات من «التأليف الذكي» أولاً.', 'info');
      return;
    }
    engine.play();
  }
  updateTransportUI();
});

$('btnStop').addEventListener('click', () => {
  if (isCountingIn) {
    countInCancelled = true;
    $('countInOverlay').classList.add('hidden');
    isCountingIn = false;
    return;
  }
  if (engine.isRecording) {
    finishRecording();
    return;
  }
  engine.stop(true);
  updateTransportUI();
});

$('btnRewind').addEventListener('click', () => {
  if (engine.isRecording) return;
  engine.seek(0);
  updateTransportUI();
});

$('btnTestMic').addEventListener('click', async () => {
  try {
    if (engine.micStream) {
      engine.releaseMicrophone();
      $('btnTestMic').textContent = 'تفعيل الميكروفون';
      showToast('تم إغلاق الميكروفون.', 'info');
    } else {
      await engine.initMicrophone(false);
      $('btnTestMic').textContent = 'الميكروفون جاهز ✓';
      showToast('الميكروفون متصل! تحدّث أو غنّ للتأكد من مستوى الإشارة.', 'success');
    }
  } catch (err) {
    console.error(err);
    showToast('لم يتم السماح بالوصول للميكروفون. يرجى منح الإذن من إعدادات المتصفح.', 'error');
  }
});

$('chkMonitor').addEventListener('change', (e) => {
  engine.setLiveMonitoring(e.target.checked);
  if (e.target.checked) {
    showToast('المراقبة الحية مفعّلة — استخدم سماعات الرأس لتجنّب الصدى!', 'info');
  }
});

async function runCountIn(acapella = false) {
  isCountingIn = true;
  countInCancelled = false;
  const overlay = $('countInOverlay');
  const numEl = $('countInNumber');
  $('countInLabel').textContent = acapella
    ? 'استعد للغناء بدون موسيقى (أكابيلا)...'
    : 'استعد للغناء...';
  overlay.classList.remove('hidden');

  const beatMs = Math.round(60000 / clamp(engine.state.metronome.bpm, 50, 180));
  for (let i = 3; i >= 1; i--) {
    if (countInCancelled) {
      overlay.classList.add('hidden');
      isCountingIn = false;
      return false;
    }
    numEl.textContent = String(i);
    engine.playMetronomeClick(i === 1);
    await new Promise((r) => setTimeout(r, beatMs));
  }

  overlay.classList.add('hidden');
  isCountingIn = false;
  return !countInCancelled;
}

function finishRecording() {
  const take = engine.stopRecording();
  updateTransportUI();
  if (take) {
    refreshVocalTakesUI();
    if (lastRecordingWasAcapella || !engine.backingBuffer) {
      switchTab('composer');
      runVocalAnalysis();
      showToast('تم حفظ غنائك وتحليله! اختر الآلات والإيقاع واضغط «توليد التوزيع» لتأليف الموسيقى على صوتك.', 'success');
    } else {
      showToast(`تم حفظ "${take.name}" بنجاح! اضغط تشغيل لسماع الصوت مع الإيفكتات.`, 'success');
    }
  } else {
    showToast('التسجيل قصير جداً ولم يتم حفظه.', 'info');
  }
}

async function beginRecordingFlow(acapella = false) {
  if (isCountingIn) {
    countInCancelled = true;
    return;
  }
  if (engine.isRecording) {
    finishRecording();
    return;
  }

  try {
    if (!engine.micStream) {
      await engine.initMicrophone(false);
      $('btnTestMic').textContent = 'الميكروفون جاهز ✓';
    }
  } catch (err) {
    console.error(err);
    showToast('تعذّر الوصول إلى الميكروفون. تأكد من توصيل الميكروفون ومنح الإذن.', 'error');
    return;
  }

  lastRecordingWasAcapella = acapella;
  const startFrom = acapella
    ? 0
    : (engine.playheadSec >= engine.getDuration() - 0.5 ? 0 : engine.playheadSec);
  engine.stop(false);

  if ($('chkCountIn').checked) {
    const ok = await runCountIn(acapella);
    if (!ok) return;
  }

  await engine.startRecording(startFrom, { acapella });
  updateTransportUI();
  showToast(
    acapella
      ? 'بدأ تسجيل الغناء بدون موسيقى... غنّ بحرية ثم اضغط «إنهاء التسجيل» ليؤلّف البرنامج الكوردات!'
      : 'بدأ التسجيل الآن... غنّ مع الموسيقى!',
    'info'
  );
}

$('btnRecord').addEventListener('click', () => beginRecordingFlow(false));
$('btnRecordAcapella').addEventListener('click', () => beginRecordingFlow(true));

// ==========================================================================
// Waveform Scrubbing
// ==========================================================================
function bindWaveformScrub(canvas) {
  let dragging = false;
  const seekAtEvent = (e) => {
    if (engine.isRecording) return;
    const dur = engine.getDuration();
    if (dur <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const sec = (x / rect.width) * dur;
    engine.seek(sec);
    updateTransportUI();
  };
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    seekAtEvent(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) seekAtEvent(e);
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
}

bindWaveformScrub($('backingWaveCanvas'));
bindWaveformScrub($('vocalWaveCanvas'));

// ==========================================================================
// Mixer, Vocal FX, Creative FX & Mastering Controls Binding
// ==========================================================================
function schedulePlaybackRefresh() {
  if (!engine.isPlaying) return;
  clearTimeout(restartDebounceTimer);
  restartDebounceTimer = setTimeout(() => {
    if (engine.isPlaying) {
      const pos = engine.getCurrentTime();
      engine.play(pos);
    }
  }, 180);
}

function setPill(id, active, onLabel = 'مفعّل', offLabel = 'مطفأ') {
  const el = $(id);
  el.classList.toggle('active', !!active);
  el.textContent = active ? onLabel : offLabel;
}

function syncControlsFromState() {
  const s = engine.state;
  const fx = s.vocalFx;
  const m = s.master;

  // Track controls
  $('rngBackingVol').value = s.backing.volume;
  $('valBackingVol').textContent = formatDb(s.backing.volume);
  $('rngBackingPan').value = s.backing.pan;
  $('valBackingPan').textContent = formatPan(s.backing.pan);
  $('btnBackingMute').classList.toggle('active-mute', s.backing.muted);
  $('btnBackingSolo').classList.toggle('active-solo', s.backing.solo);

  $('rngVocalVol').value = s.vocal.volume;
  $('valVocalVol').textContent = formatDb(s.vocal.volume);
  $('rngVocalSync').value = s.vocal.syncOffsetMs;
  $('valVocalSync').textContent = `${s.vocal.syncOffsetMs > 0 ? '+' : ''}${s.vocal.syncOffsetMs} ms`;
  $('rngAutoDuck').value = s.vocal.duckingDb;
  $('valAutoDuck').textContent = `${Number(s.vocal.duckingDb).toFixed(1)} dB`;
  $('btnVocalMute').classList.toggle('active-mute', s.vocal.muted);
  $('btnVocalSolo').classList.toggle('active-solo', s.vocal.solo);

  setPill('btnVocalFxToggle', s.vocal.fxEnabled, 'FX مفعّل', 'FX متوقف');
  const atActive = !!(s.vocal.fxEnabled && fx.autoTuneEnabled);
  setPill('btnTrackAutoTuneToggle', atActive, 'Auto-Tune مفعّل', 'Auto-Tune مغلق');
  setPill('btnToggleAutoTune', fx.autoTuneEnabled, 'إغلاق الأوتو تيون (مفعّل)', 'تشغيل الأوتو تيون');
  $('autoTuneModuleCard').classList.toggle('is-active', atActive);

  $('fxAutoTuneKey').value = String(fx.autoTuneKey);
  $('fxAutoTuneScale').value = fx.autoTuneScale;
  $('fxAutoTuneSpeed').value = fx.autoTuneSpeed;
  $('valFxAutoTuneSpeed').textContent = `${fx.autoTuneSpeed}%`;
  $('fxAutoTuneAmount').value = fx.autoTuneAmount;
  $('valFxAutoTuneAmount').textContent = `${fx.autoTuneAmount}%`;
  updateAutoTuneStatusBadge();

  setPill('btnToggleEq', fx.eqEnabled !== false);
  setPill('btnToggleComp', fx.compEnabled !== false);
  setPill('btnToggleReverb', fx.reverbEnabled !== false, 'صدى مفعّل', 'صدى مطفأ');
  setPill('btnToggleDelay', fx.delayEnabled !== false, 'ديلاي مفعّل', 'ديلاي مطفأ');

  // Sync FL Vertical Mixer Console Strips
  $('rngMixerMaster').value = m.masterVolume;
  $('valMixerMaster').textContent = `${m.masterVolume > 0 ? '+' : ''}${Number(m.masterVolume).toFixed(1)}`;
  $('btnMixerMasterLed').classList.toggle('active', !!m.enabled);
  $('btnMixerMasterLed').textContent = m.enabled ? 'ON' : 'OFF';

  $('rngMixerBacking').value = s.backing.volume;
  $('valMixerBacking').textContent = s.backing.volume <= -60 ? '-∞' : `${s.backing.volume > 0 ? '+' : ''}${Number(s.backing.volume).toFixed(1)}`;
  $('btnMixerBackingLed').classList.toggle('active', !s.backing.muted);
  $('btnMixerBackingLed').textContent = s.backing.muted ? 'MUTE' : 'ON';

  $('rngMixerVocal').value = s.vocal.volume;
  $('valMixerVocal').textContent = s.vocal.volume <= -60 ? '-∞' : `${s.vocal.volume > 0 ? '+' : ''}${Number(s.vocal.volume).toFixed(1)}`;
  $('btnMixerVocalLed').classList.toggle('active', !s.vocal.muted);
  $('btnMixerVocalLed').textContent = s.vocal.muted ? 'MUTE' : 'ON';

  // Sync FL 8-Slot Insert 2 FX Rack LEDs
  const fxMasterOn = !!s.vocal.fxEnabled;
  $('slotLedAutoTune').classList.toggle('active', fxMasterOn && !!fx.autoTuneEnabled);
  $('slotLedEq').classList.toggle('active', fxMasterOn && fx.eqEnabled !== false);
  $('slotLedComp').classList.toggle('active', fxMasterOn && fx.compEnabled !== false);
  $('slotLedReverb').classList.toggle('active', fxMasterOn && fx.reverbEnabled !== false);
  $('slotLedDelay').classList.toggle('active', fxMasterOn && fx.delayEnabled !== false);
  $('slotLedHarmony').classList.toggle('active', fxMasterOn && !!fx.harmonyEnabled);
  $('slotLedMod').classList.toggle('active', fxMasterOn && !!fx.modEnabled);
  $('slotLedLofi').classList.toggle('active', fxMasterOn && (!!fx.lofiEnabled || !!fx.driveEnabled));

  // Creative FX Pills & Sliders
  setPill('btnToggleHarmony', fx.harmonyEnabled);
  $('fxHarmonyInterval').value = String(fx.harmonyInterval);
  $('fxHarmonyMix').value = fx.harmonyMix;
  $('valFxHarmonyMix').textContent = `${fx.harmonyMix}%`;

  setPill('btnToggleMod', fx.modEnabled);
  $('fxModType').value = fx.modType;
  $('fxModRate').value = fx.modRate;
  $('valFxModRate').textContent = `${Number(fx.modRate).toFixed(1)} Hz`;
  $('fxModDepth').value = fx.modDepth;
  $('valFxModDepth').textContent = `${fx.modDepth}%`;
  $('fxModMix').value = fx.modMix;
  $('valFxModMix').textContent = `${fx.modMix}%`;

  setPill('btnToggleLofi', fx.lofiEnabled);
  $('fxLofiStyle').value = fx.lofiStyle;
  $('fxLofiMix').value = fx.lofiMix;
  $('valFxLofiMix').textContent = `${fx.lofiMix}%`;

  setPill('btnToggleDrive', fx.driveEnabled);
  $('fxDriveAmount').value = fx.driveAmount;
  $('valFxDriveAmount').textContent = `${fx.driveAmount}%`;

  // Vocal EQ & Dynamics
  $('fxHpf').value = fx.hpfFreq;
  $('valFxHpf').textContent = `${fx.hpfFreq} Hz`;
  $('fxGate').value = fx.gateThreshold;
  $('valFxGate').textContent = fx.gateThreshold <= -78 ? 'مطفأ' : `${fx.gateThreshold} dB`;
  $('fxDeEsser').value = fx.deEsser;
  $('valFxDeEsser').textContent = `${fx.deEsser}%`;
  $('fxWarmth').value = fx.warmth;
  $('valFxWarmth').textContent = `${fx.warmth}%`;

  $('fxEqLow').value = fx.eqLow;
  $('valFxEqLow').textContent = formatDb(fx.eqLow);
  $('fxEqWarmth').value = fx.eqWarmth;
  $('valFxEqWarmth').textContent = formatDb(fx.eqWarmth);
  $('fxEqPresence').value = fx.eqPresence;
  $('valFxEqPresence').textContent = formatDb(fx.eqPresence);
  $('fxEqAir').value = fx.eqAir;
  $('valFxEqAir').textContent = formatDb(fx.eqAir);

  $('fxCompThresh').value = fx.compThreshold;
  $('valFxCompThresh').textContent = `${fx.compThreshold} dB`;
  $('fxCompRatio').value = fx.compRatio;
  $('valFxCompRatio').textContent = `${Number(fx.compRatio).toFixed(1)}:1`;
  $('fxCompAttack').value = fx.compAttack;
  $('valFxCompAttack').textContent = `${fx.compAttack} ms`;
  $('fxCompRelease').value = fx.compRelease;
  $('valFxCompRelease').textContent = `${fx.compRelease} ms`;
  $('fxCompMakeup').value = fx.compMakeup;
  $('valFxCompMakeup').textContent = formatDb(fx.compMakeup);

  $('fxReverbType').value = fx.reverbType;
  $('fxReverbMix').value = fx.reverbMix;
  $('valFxReverbMix').textContent = `${fx.reverbMix}%`;
  $('fxReverbDecay').value = fx.reverbDecay;
  $('valFxReverbDecay').textContent = `${Number(fx.reverbDecay).toFixed(1)} s`;
  $('fxReverbPre').value = fx.reverbPreDelay;
  $('valFxReverbPre').textContent = `${fx.reverbPreDelay} ms`;
  $('fxDoubler').value = fx.doublerMix;
  $('valFxDoubler').textContent = `${fx.doublerMix}%`;

  $('fxDelayMix').value = fx.delayMix;
  $('valFxDelayMix').textContent = `${fx.delayMix}%`;
  $('fxDelayTime').value = fx.delayTimeMs;
  $('valFxDelayTime').textContent = `${fx.delayTimeMs} ms`;
  $('fxDelayFb').value = fx.delayFeedback;
  $('valFxDelayFb').textContent = `${fx.delayFeedback}%`;
  $('fxDelayTone').value = fx.delayToneHz;
  $('valFxDelayTone').textContent = `${(fx.delayToneHz / 1000).toFixed(1)} kHz`;

  // Master
  setPill('btnMasterToggle', m.enabled, 'الماستر مفعّل', 'الماستر متوقف');
  $('msEqLow').value = m.eqLow;
  $('valMsEqLow').textContent = formatDb(m.eqLow);
  $('msEqMid').value = m.eqMid;
  $('valMsEqMid').textContent = formatDb(m.eqMid);
  $('msEqHigh').value = m.eqHigh;
  $('valMsEqHigh').textContent = formatDb(m.eqHigh);
  $('msWidth').value = m.stereoWidth;
  $('valMsWidth').textContent = `${m.stereoWidth}%`;
  $('msGlue').value = m.glueAmount;
  $('valMsGlue').textContent = `${m.glueAmount}%`;
  $('msDrive').value = m.limiterDrive;
  $('valMsDrive').textContent = formatDb(m.limiterDrive);
  $('msCeiling').value = m.limiterCeiling;
  $('valMsCeiling').textContent = `${Number(m.limiterCeiling).toFixed(1)} dB`;
  $('msVol').value = m.masterVolume;
  $('valMsVol').textContent = formatDb(m.masterVolume);
}

function bindSlider(id, onValue) {
  $(id).addEventListener('input', (e) => {
    onValue(parseFloat(e.target.value));
    syncControlsFromState();
  });
}

// Track Mixer Events
bindSlider('rngBackingVol', (v) => { engine.state.backing.volume = v; engine.syncLiveParams(); });
bindSlider('rngBackingPan', (v) => { engine.state.backing.pan = v; engine.syncLiveParams(); });
bindSlider('rngVocalVol', (v) => { engine.state.vocal.volume = v; engine.syncLiveParams(); });
bindSlider('rngVocalSync', (v) => { engine.state.vocal.syncOffsetMs = v; schedulePlaybackRefresh(); });
bindSlider('rngAutoDuck', (v) => { engine.state.vocal.duckingDb = v; schedulePlaybackRefresh(); });

$('btnBackingMute').addEventListener('click', () => {
  engine.state.backing.muted = !engine.state.backing.muted;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnBackingSolo').addEventListener('click', () => {
  engine.state.backing.solo = !engine.state.backing.solo;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnVocalMute').addEventListener('click', () => {
  engine.state.vocal.muted = !engine.state.vocal.muted;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnVocalSolo').addEventListener('click', () => {
  engine.state.vocal.solo = !engine.state.vocal.solo;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnVocalFxToggle').addEventListener('click', () => {
  engine.state.vocal.fxEnabled = !engine.state.vocal.fxEnabled;
  syncControlsFromState();
  engine.syncLiveParams();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
  drawEqCurve($('eqCurveCanvas'), engine);
});

// Auto-Tune Status, Preview & Controls
let autoTunePreviewTimer = null;

function updateAutoTuneStatusBadge() {
  const badge = $('autoTuneStatusBadge');
  const fx = engine.state.vocalFx;
  if (!fx.autoTuneEnabled || !engine.state.vocal.fxEnabled) {
    badge.textContent = 'مغلق (Bypass)';
    return;
  }
  const st = engine.lastAutoTuneStats;
  if (st && st.voicedFrames > 0) {
    const scaleName = AUTOTUNE_SCALES[st.scaleId]?.name || st.scaleId;
    const keyName = NOTE_NAMES_AR[st.rootPc] || NOTE_NAMES[st.rootPc];
    badge.textContent = `مفعّل: ${keyName} • ${scaleName} (متوسط التصحيح ${Math.round(st.avgCentsCorrected)} cents)`;
  } else {
    badge.textContent = 'مفعّل — جاهز للتصحيح على صوتك';
  }
}

function refreshAutoTunePreview() {
  clearTimeout(autoTunePreviewTimer);
  const fx = engine.state.vocalFx;
  if (!fx.autoTuneEnabled || !engine.state.vocal.fxEnabled) {
    updateAutoTuneStatusBadge();
    return;
  }
  autoTunePreviewTimer = setTimeout(() => {
    if (engine.activeVocalBuffer) {
      engine.computeAutoTunePreview();
    }
    updateAutoTuneStatusBadge();
  }, 90);
}

function toggleAutoTune(forceVal = null) {
  const next = forceVal !== null ? !!forceVal : !engine.state.vocalFx.autoTuneEnabled;
  engine.state.vocalFx.autoTuneEnabled = next;
  if (next && !engine.state.vocal.fxEnabled) {
    engine.state.vocal.fxEnabled = true;
  }
  engine._invalidateAutoTune();
  syncControlsFromState();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
  showToast(
    next
      ? 'تم تشغيل الأوتو تيون للفوكال! اضغط تشغيل لسماع تصحيح النغمة.'
      : 'تم إغلاق الأوتو تيون (الصوت بدون تصحيح نغمة).',
    next ? 'success' : 'info'
  );
}

$('btnToggleAutoTune').addEventListener('click', () => toggleAutoTune());
$('btnTrackAutoTuneToggle').addEventListener('click', () => toggleAutoTune());

$('btnAtModeNatural').addEventListener('click', () => {
  engine.state.vocalFx.autoTuneEnabled = true;
  engine.state.vocalFx.autoTuneSpeed = 28;
  engine.state.vocalFx.autoTuneAmount = 65;
  engine._invalidateAutoTune();
  syncControlsFromState();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
  showToast('وضع الأوتو تيون: تصحيح طبيعي ناعم (يحافظ على إحساس الصوت).', 'success');
});

$('btnAtModePop').addEventListener('click', () => {
  engine.state.vocalFx.autoTuneEnabled = true;
  engine.state.vocalFx.autoTuneSpeed = 62;
  engine.state.vocalFx.autoTuneAmount = 85;
  engine._invalidateAutoTune();
  syncControlsFromState();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
  showToast('وضع الأوتو تيون: بوب استوديو متوازن.', 'success');
});

$('btnAtModeHard').addEventListener('click', () => {
  engine.state.vocalFx.autoTuneEnabled = true;
  engine.state.vocalFx.autoTuneSpeed = 96;
  engine.state.vocalFx.autoTuneAmount = 100;
  engine._invalidateAutoTune();
  syncControlsFromState();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
  showToast('وضع الأوتو تيون: هارد أوتو تيون (تراب / T-Pain).', 'success');
});

$('fxAutoTuneKey').addEventListener('change', (e) => {
  engine.state.vocalFx.autoTuneKey = parseInt(e.target.value, 10);
  engine._invalidateAutoTune();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
});

$('fxAutoTuneScale').addEventListener('change', (e) => {
  engine.state.vocalFx.autoTuneScale = e.target.value;
  engine._invalidateAutoTune();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
});

bindSlider('fxAutoTuneSpeed', (v) => {
  engine.state.vocalFx.autoTuneSpeed = v;
  engine._invalidateAutoTune();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
});

bindSlider('fxAutoTuneAmount', (v) => {
  engine.state.vocalFx.autoTuneAmount = v;
  engine._invalidateAutoTune();
  refreshAutoTunePreview();
  schedulePlaybackRefresh();
});

// Per-Module FX Toggles
$('btnToggleEq').addEventListener('click', () => {
  engine.state.vocalFx.eqEnabled = !(engine.state.vocalFx.eqEnabled !== false);
  syncControlsFromState();
  engine.syncLiveParams({ eqToggleChanged: true });
  drawEqCurve($('eqCurveCanvas'), engine);
});
$('btnToggleComp').addEventListener('click', () => {
  engine.state.vocalFx.compEnabled = !(engine.state.vocalFx.compEnabled !== false);
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnToggleReverb').addEventListener('click', () => {
  engine.state.vocalFx.reverbEnabled = !(engine.state.vocalFx.reverbEnabled !== false);
  syncControlsFromState();
  engine.syncLiveParams();
});
$('btnToggleDelay').addEventListener('click', () => {
  engine.state.vocalFx.delayEnabled = !(engine.state.vocalFx.delayEnabled !== false);
  syncControlsFromState();
  engine.syncLiveParams();
});

// Creative FX Controls
$('btnToggleHarmony').addEventListener('click', () => {
  engine.state.vocalFx.harmonyEnabled = !engine.state.vocalFx.harmonyEnabled;
  syncControlsFromState();
  schedulePlaybackRefresh();
});
$('fxHarmonyInterval').addEventListener('change', (e) => {
  engine.state.vocalFx.harmonyInterval = parseInt(e.target.value, 10);
  engine._harmonyCache = { key: '', buffer: null };
  schedulePlaybackRefresh();
});
bindSlider('fxHarmonyMix', (v) => { engine.state.vocalFx.harmonyMix = v; engine.syncLiveParams(); });

$('btnToggleMod').addEventListener('click', () => {
  engine.state.vocalFx.modEnabled = !engine.state.vocalFx.modEnabled;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('fxModType').addEventListener('change', (e) => {
  engine.state.vocalFx.modType = e.target.value;
  engine.syncLiveParams();
});
bindSlider('fxModRate', (v) => { engine.state.vocalFx.modRate = v; engine.syncLiveParams(); });
bindSlider('fxModDepth', (v) => { engine.state.vocalFx.modDepth = v; engine.syncLiveParams(); });
bindSlider('fxModMix', (v) => { engine.state.vocalFx.modMix = v; engine.syncLiveParams(); });

$('btnToggleLofi').addEventListener('click', () => {
  engine.state.vocalFx.lofiEnabled = !engine.state.vocalFx.lofiEnabled;
  syncControlsFromState();
  engine.syncLiveParams();
});
$('fxLofiStyle').addEventListener('change', (e) => {
  engine.state.vocalFx.lofiStyle = e.target.value;
  engine.syncLiveParams();
});
bindSlider('fxLofiMix', (v) => { engine.state.vocalFx.lofiMix = v; engine.syncLiveParams(); });

$('btnToggleDrive').addEventListener('click', () => {
  engine.state.vocalFx.driveEnabled = !engine.state.vocalFx.driveEnabled;
  syncControlsFromState();
  engine.syncLiveParams({ driveChanged: true });
});
bindSlider('fxDriveAmount', (v) => { engine.state.vocalFx.driveAmount = v; engine.syncLiveParams({ driveChanged: true }); });

// Vocal EQ & Dynamics Sliders
const onEqChange = () => {
  engine.syncLiveParams();
  drawEqCurve($('eqCurveCanvas'), engine);
};

bindSlider('fxHpf', (v) => { engine.state.vocalFx.hpfFreq = v; onEqChange(); });
bindSlider('fxGate', (v) => {
  engine.state.vocalFx.gateThreshold = v;
  engine._invalidateGatedVocal();
  schedulePlaybackRefresh();
});
bindSlider('fxDeEsser', (v) => { engine.state.vocalFx.deEsser = v; onEqChange(); });
bindSlider('fxWarmth', (v) => { engine.state.vocalFx.warmth = v; engine.syncLiveParams({ warmthChanged: true }); });
bindSlider('fxEqLow', (v) => { engine.state.vocalFx.eqLow = v; onEqChange(); });
bindSlider('fxEqWarmth', (v) => { engine.state.vocalFx.eqWarmth = v; onEqChange(); });
bindSlider('fxEqPresence', (v) => { engine.state.vocalFx.eqPresence = v; onEqChange(); });
bindSlider('fxEqAir', (v) => { engine.state.vocalFx.eqAir = v; onEqChange(); });

bindSlider('fxCompThresh', (v) => { engine.state.vocalFx.compThreshold = v; engine.syncLiveParams(); });
bindSlider('fxCompRatio', (v) => { engine.state.vocalFx.compRatio = v; engine.syncLiveParams(); });
bindSlider('fxCompAttack', (v) => { engine.state.vocalFx.compAttack = v; engine.syncLiveParams(); });
bindSlider('fxCompRelease', (v) => { engine.state.vocalFx.compRelease = v; engine.syncLiveParams(); });
bindSlider('fxCompMakeup', (v) => { engine.state.vocalFx.compMakeup = v; engine.syncLiveParams(); });

$('fxReverbType').addEventListener('change', (e) => {
  engine.state.vocalFx.reverbType = e.target.value;
  engine.syncLiveParams({ reverbIRChanged: true });
});
bindSlider('fxReverbMix', (v) => { engine.state.vocalFx.reverbMix = v; engine.syncLiveParams(); });
bindSlider('fxReverbDecay', (v) => { engine.state.vocalFx.reverbDecay = v; engine.syncLiveParams({ reverbIRChanged: true }); });
bindSlider('fxReverbPre', (v) => { engine.state.vocalFx.reverbPreDelay = v; engine.syncLiveParams(); });
bindSlider('fxDoubler', (v) => { engine.state.vocalFx.doublerMix = v; engine.syncLiveParams(); });

bindSlider('fxDelayMix', (v) => { engine.state.vocalFx.delayMix = v; engine.syncLiveParams(); });
bindSlider('fxDelayTime', (v) => { engine.state.vocalFx.delayTimeMs = v; engine.syncLiveParams(); });
bindSlider('fxDelayFb', (v) => { engine.state.vocalFx.delayFeedback = v; engine.syncLiveParams(); });
bindSlider('fxDelayTone', (v) => { engine.state.vocalFx.delayToneHz = v; engine.syncLiveParams(); });

// Master Controls
$('btnMasterToggle').addEventListener('click', () => {
  engine.state.master.enabled = !engine.state.master.enabled;
  syncControlsFromState();
  engine.syncLiveParams();
});
bindSlider('msEqLow', (v) => { engine.state.master.eqLow = v; engine.syncLiveParams(); });
bindSlider('msEqMid', (v) => { engine.state.master.eqMid = v; engine.syncLiveParams(); });
bindSlider('msEqHigh', (v) => { engine.state.master.eqHigh = v; engine.syncLiveParams(); });
bindSlider('msWidth', (v) => { engine.state.master.stereoWidth = v; engine.syncLiveParams(); });
bindSlider('msGlue', (v) => { engine.state.master.glueAmount = v; engine.syncLiveParams(); });
bindSlider('msDrive', (v) => { engine.state.master.limiterDrive = v; engine.syncLiveParams(); });
bindSlider('msCeiling', (v) => { engine.state.master.limiterCeiling = v; engine.syncLiveParams({ ceilingChanged: true }); });
bindSlider('msVol', (v) => { engine.state.master.masterVolume = v; engine.syncLiveParams(); });

// ==========================================================================
// Export MP3 / WAV Workflow
// ==========================================================================
$('exportFormat').addEventListener('change', (e) => {
  $('bitrateField').style.opacity = e.target.value === 'mp3' ? '1' : '0.45';
  $('exportBitrate').disabled = e.target.value !== 'mp3';
});

$('btnStartExport').addEventListener('click', async () => {
  if (!engine.backingBuffer && !engine.activeVocalBuffer) {
    showToast('أضف موسيقى أو سجّل صوت غناء أولاً قبل الاستخراج!', 'error');
    return;
  }

  const format = $('exportFormat').value;
  const bitrate = parseInt($('exportBitrate').value, 10) || 192;
  const normalize = $('exportNormalize').checked;
  const rawName = ($('exportFileName').value || 'nagham-mix').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const fileName = `${rawName}.${format}`;

  const btn = $('btnStartExport');
  btn.disabled = true;
  $('exportProgressBox').classList.remove('hidden');
  $('exportProgressFill').style.width = '5%';
  $('exportProgressPct').textContent = '5%';
  $('exportProgressMsg').textContent = 'جاري تجهيز محرك الميكس...';

  try {
    engine.stop(false);
    updateTransportUI();

    const result = await engine.exportMix({
      format,
      bitrate,
      normalize,
      onProgress: ({ percent, message }) => {
        $('exportProgressFill').style.width = `${percent}%`;
        $('exportProgressPct').textContent = `${percent}%`;
        $('exportProgressMsg').textContent = message;
      },
    });

    if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
    lastExportUrl = result.url;

    $('exportEmptyState').classList.add('hidden');
    $('exportResultState').classList.remove('hidden');

    $('resFormat').textContent = format === 'mp3' ? `MP3 ${bitrate} kbps` : 'WAV 16-bit PCM';
    $('resSize').textContent = formatBytes(result.sizeBytes);
    $('resDuration').textContent = formatTime(result.durationSec);
    $('resLoudness').textContent = `${result.approxLufs.toFixed(1)} LUFS / ${result.peakDb.toFixed(1)} dB`;

    $('exportAudioPreview').src = result.url;
    const dl = $('btnDownloadFile');
    dl.href = result.url;
    dl.download = fileName;
    dl.textContent = `تحميل ${fileName} (${formatBytes(result.sizeBytes)})`;

    showToast(`تم استخراج ${fileName} بنجاح! يمكنك معاينته وتحميله الآن.`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`حدث خطأ أثناء الاستخراج: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ==========================================================================
// Keyboard Shortcuts
// ==========================================================================
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    $('btnPlayPause').click();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    $('btnRecord').click();
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    $('btnMetronomeToggle').click();
  } else if (e.code === 'Home') {
    e.preventDefault();
    $('btnRewind').click();
  } else if (e.code === 'Escape') {
    $('btnStop').click();
  }
});

// ==========================================================================
// Real-Time Animation Loop
// ==========================================================================
function animationLoop() {
  const curTime = engine.getCurrentTime();
  const totalDur = engine.getDuration();

  if (engine.isPlaying && totalDur > 0 && curTime >= totalDur + 0.05) {
    engine.stop(true);
    updateTransportUI();
  }

  $('timeCurrent').textContent = formatTime(curTime);
  $('timeTotal').textContent = formatTime(totalDur);

  drawWaveformTrack($('backingWaveCanvas'), {
    peaks: backingPeaks,
    bufferDuration: engine.backingBuffer ? engine.backingBuffer.duration : 0,
    totalDuration: Math.max(totalDur, engine.isRecording ? curTime + 5 : totalDur),
    offsetSec: engine.state.backing.offsetSec,
    playheadSec: curTime,
    color: '#e59a3c',
    bgTint: 'rgba(229, 154, 60, 0.07)',
    muted: engine.state.backing.muted,
    emptyLabel: 'ارفع موسيقى أو ألّف كوردات وآلات تلقائياً بعد الغناء بدون موسيقى',
  });

  drawWaveformTrack($('vocalWaveCanvas'), {
    peaks: vocalPeaks,
    bufferDuration: engine.activeVocalBuffer ? engine.activeVocalBuffer.duration : 0,
    totalDuration: Math.max(totalDur, engine.isRecording ? curTime + 5 : totalDur),
    offsetSec: engine.state.vocal.syncOffsetMs / 1000,
    playheadSec: curTime,
    color: '#38bdf8',
    bgTint: 'rgba(56, 189, 248, 0.08)',
    muted: engine.state.vocal.muted,
    isRecording: engine.isRecording,
    recordPeaks: engine.recordPeakHistory,
    recordStartSec: engine.playStartOffsetSec,
    emptyLabel: 'اضغط «تسجيل غناء» أو «غناء بدون موسيقى (أكابيلا)» للبدء',
  });

  const meters = engine.getMeterData();

  const micPct = Math.min(100, Math.max(0, ((gainToDb(meters.mic.peak) + 54) / 54) * 100));
  $('micMeterFill').style.width = `${engine.micStream ? micPct : 0}%`;

  topVu.update(meters.masterL.peak, meters.masterR.peak);
  topVu.draw($('topVuCanvas'));

  masterVu.update(meters.masterL.peak, meters.masterR.peak);
  if ($('panel-mastering').classList.contains('active')) {
    masterVu.draw($('masterVuCanvas'));
    drawSpectrum($('spectrumCanvas'), meters.fft);

    const maxPeak = Math.max(meters.masterL.peak, meters.masterR.peak);
    $('livePeakDb').textContent = engine.isPlaying ? `${gainToDb(maxPeak).toFixed(1)} dB` : '-∞ dB';
    $('masterGrVal').textContent = `-${meters.masterGlueGR.toFixed(1)} dB`;
  }

  const gr = meters.vocalCompGR;
  $('vocalGrBar').style.width = `${Math.min(100, (gr / 18) * 100)}%`;
  $('vocalGrVal').textContent = `-${gr.toFixed(1)} dB`;

  if ($('panel-vocal-fx').classList.contains('active')) {
    topVu.drawVertical($('mixerMasterVu'));
    const atOn = !!(engine.state.vocal.fxEnabled && engine.state.vocalFx.autoTuneEnabled);
    const vDur = engine.activeVocalBuffer ? engine.activeVocalBuffer.duration : 0;
    const vPlayhead = Math.max(0, curTime - engine.state.vocal.syncOffsetMs / 1000);
    drawAutoTuneGraph($('autoTuneCanvas'), engine.lastAutoTuneStats, vDur, vPlayhead, atOn);
  }

  requestAnimationFrame(animationLoop);
}

// ==========================================================================
// FL Vertical Mixer Strips & 8-Slot FX Rack Bindings
// ==========================================================================
bindSlider('rngMixerMaster', (v) => { engine.state.master.masterVolume = v; engine.syncLiveParams(); });
bindSlider('rngMixerBacking', (v) => { engine.state.backing.volume = v; engine.syncLiveParams(); });
bindSlider('rngMixerVocal', (v) => { engine.state.vocal.volume = v; engine.syncLiveParams(); });

$('btnMixerMasterLed').addEventListener('click', () => $('btnMasterToggle').click());
$('btnMixerBackingLed').addEventListener('click', () => $('btnBackingMute').click());
$('btnMixerVocalLed').addEventListener('click', () => $('btnVocalMute').click());

$('slotLedAutoTune').addEventListener('click', () => toggleAutoTune());
$('slotLedEq').addEventListener('click', () => $('btnToggleEq').click());
$('slotLedComp').addEventListener('click', () => $('btnToggleComp').click());
$('slotLedReverb').addEventListener('click', () => $('btnToggleReverb').click());
$('slotLedDelay').addEventListener('click', () => $('btnToggleDelay').click());
$('slotLedHarmony').addEventListener('click', () => $('btnToggleHarmony').click());
$('slotLedMod').addEventListener('click', () => $('btnToggleMod').click());
$('slotLedLofi').addEventListener('click', () => $('btnToggleLofi').click());

document.querySelectorAll('[data-focus-module]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const el = $(btn.dataset.focusModule);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash-focus');
    setTimeout(() => el.classList.remove('flash-focus'), 900);
  });
});

// ==========================================================================
// Initialize Studio
// ==========================================================================
initDemoBeatsAndPresets();
syncControlsFromState();
updateMetronomeUI();
drawEqCurve($('eqCurveCanvas'), engine);
window.addEventListener('resize', () => {
  if ($('panel-vocal-fx').classList.contains('active')) {
    drawEqCurve($('eqCurveCanvas'), engine);
  }
});
requestAnimationFrame(animationLoop);
