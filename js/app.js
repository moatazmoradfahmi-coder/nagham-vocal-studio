/**
 * Nagham Studio — Main UI Controller & Application Orchestration
 */

import { StudioAudioEngine, gainToDb } from './audio-engine.js';
import { VOCAL_PRESETS, MASTER_PRESETS, DEMO_BEATS } from './presets.js';
import {
  computeWaveformPeaks,
  drawWaveformTrack,
  drawEqCurve,
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

// DOM Helpers
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
  }, 3600);
}

// ==========================================================================
// Tab Switching
// ==========================================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
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

$('btnQuickExport').addEventListener('click', () => {
  switchTab('export');
  $('panel-export').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ==========================================================================
// Populate Demo Beats & Presets
// ==========================================================================
function initDemoBeatsAndPresets() {
  const demoSel = $('selectDemoBeat');
  DEMO_BEATS.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.name} (${b.bpm} BPM • ${b.key})`;
    demoSel.appendChild(opt);
  });

  // Vocal Presets
  const vocalGrid = $('vocalPresetsGrid');
  VOCAL_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `preset-chip ${p.id === activeVocalPresetId ? 'active' : ''}`;
    btn.dataset.presetId = p.id;
    btn.title = p.description;
    btn.textContent = p.name;
    btn.addEventListener('click', () => applyVocalPreset(p));
    vocalGrid.appendChild(btn);
  });

  // Master Presets
  const masterGrid = $('masterPresetsGrid');
  MASTER_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `preset-chip ${p.id === activeMasterPresetId ? 'active' : ''}`;
    btn.dataset.masterId = p.id;
    btn.textContent = p.name;
    btn.addEventListener('click', () => applyMasterPreset(p));
    masterGrid.appendChild(btn);
  });
}

function applyVocalPreset(preset) {
  activeVocalPresetId = preset.id;
  Object.assign(engine.state.vocalFx, preset.fx);
  engine.state.vocal.fxEnabled = preset.id !== 'flat_raw';
  engine._invalidateGatedVocal();

  document.querySelectorAll('#vocalPresetsGrid .preset-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.presetId === preset.id);
  });

  syncControlsFromState();
  engine.syncLiveParams({ reverbIRChanged: true, warmthChanged: true });
  drawEqCurve($('eqCurveCanvas'), engine);
  showToast(`تم تطبيق قالب الصوت: ${preset.name}`, 'success');
}

function applyMasterPreset(preset) {
  activeMasterPresetId = preset.id;
  Object.assign(engine.state.master, preset.master);

  document.querySelectorAll('#masterPresetsGrid .preset-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.masterId === preset.id);
  });

  syncControlsFromState();
  engine.syncLiveParams({ ceilingChanged: true });
  showToast(`تم تطبيق قالب الماستر: ${preset.name}`, 'success');
}

// ==========================================================================
// Track Loading (File Upload, Drag & Drop, Built-In Demo Beats)
// ==========================================================================
async function handleBackingLoad(file) {
  try {
    showToast('جاري تحميل ومعالجة ملف الموسيقى...', 'info');
    const buf = await engine.loadBackingFile(file);
    backingPeaks = computeWaveformPeaks(buf, 650);
    $('backingFileName').textContent = `${file.name} (${formatTime(buf.duration)})`;
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
    updateTransportUI();
    showToast(`تم تجهيز ${info.name} — اضغط تشغيل أو ابدأ تسجيل غنائك!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('حدث خطأ أثناء توليد الإيقاع التجريبي.', 'error');
  }
});

// Drag & Drop support on both tracks
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
}

$('selectVocalTake').addEventListener('change', (e) => {
  const idx = parseInt(e.target.value, 10);
  engine.selectVocalTake(idx);
  if (engine.activeVocalBuffer) {
    vocalPeaks = computeWaveformPeaks(engine.activeVocalBuffer, 650);
  }
});

$('btnDeleteTake').addEventListener('click', () => {
  if (engine.activeTakeIndex < 0) return;
  engine.deleteVocalTake(engine.activeTakeIndex);
  refreshVocalTakesUI();
  updateTransportUI();
  showToast('تم حذف التسجيل.', 'info');
});

// ==========================================================================
// Transport & Synchronized Vocal Recording
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
      showToast('أضف موسيقى خلفية أو اختر إيقاعاً تجريبياً أولاً.', 'info');
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

async function runCountIn() {
  isCountingIn = true;
  countInCancelled = false;
  const overlay = $('countInOverlay');
  const numEl = $('countInNumber');
  overlay.classList.remove('hidden');

  for (let i = 3; i >= 1; i--) {
    if (countInCancelled) {
      overlay.classList.add('hidden');
      isCountingIn = false;
      return false;
    }
    numEl.textContent = String(i);
    engine.playMetronomeClick(i === 1);
    await new Promise((r) => setTimeout(r, 650));
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
    showToast(`تم حفظ "${take.name}" بنجاح! اضغط تشغيل لسماع الصوت مع الفلاتر.`, 'success');
  } else {
    showToast('التسجيل قصير جداً ولم يتم حفظه.', 'info');
  }
}

$('btnRecord').addEventListener('click', async () => {
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

  const startFrom = engine.playheadSec >= engine.getDuration() - 0.5 ? 0 : engine.playheadSec;
  engine.stop(false);

  if ($('chkCountIn').checked) {
    const ok = await runCountIn();
    if (!ok) return;
  }

  await engine.startRecording(startFrom);
  updateTransportUI();
  showToast('بدأ التسجيل الآن... غنّ مع الموسيقى!', 'info');
});

// ==========================================================================
// Waveform Scrubbing (Click & Drag Seek)
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
// Mixer, Vocal FX, and Mastering Controls Binding
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

  $('btnVocalFxToggle').classList.toggle('active', s.vocal.fxEnabled);
  $('btnVocalFxToggle').textContent = s.vocal.fxEnabled ? 'FX مفعّل' : 'FX متوقف';

  // Vocal FX
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
  $('btnMasterToggle').classList.toggle('active', m.enabled);
  $('btnMasterToggle').textContent = m.enabled ? 'الماستر مفعّل' : 'الماستر متوقف';
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
  drawEqCurve($('eqCurveCanvas'), engine);
});

// Vocal FX Sliders
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
  } else if (e.code === 'Home') {
    e.preventDefault();
    $('btnRewind').click();
  } else if (e.code === 'Escape') {
    $('btnStop').click();
  }
});

// ==========================================================================
// Real-Time Animation Loop (Waveforms, Playhead, VU Meters, FFT, GR)
// ==========================================================================
function animationLoop() {
  const curTime = engine.getCurrentTime();
  const totalDur = engine.getDuration();

  // Auto-stop when playback finishes
  if (engine.isPlaying && totalDur > 0 && curTime >= totalDur + 0.05) {
    engine.stop(true);
    updateTransportUI();
  }

  $('timeCurrent').textContent = formatTime(curTime);
  $('timeTotal').textContent = formatTime(totalDur);

  // Draw Track 1 (Backing Waveform)
  drawWaveformTrack($('backingWaveCanvas'), {
    peaks: backingPeaks,
    bufferDuration: engine.backingBuffer ? engine.backingBuffer.duration : 0,
    totalDuration: Math.max(totalDur, engine.isRecording ? curTime + 5 : totalDur),
    offsetSec: engine.state.backing.offsetSec,
    playheadSec: curTime,
    color: '#e59a3c',
    bgTint: 'rgba(229, 154, 60, 0.07)',
    muted: engine.state.backing.muted,
    emptyLabel: 'ارفع ملف موسيقى (MP3/WAV) أو اختر إيقاعاً جاهزاً من القائمة',
  });

  // Draw Track 2 (Vocal Waveform or Live Recording Waveform)
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
    emptyLabel: 'اضغط «تسجيل غناء» للبدء، أو استورد تسجيل غناء جاهز',
  });

  // Meters
  const meters = engine.getMeterData();

  // Mic Live Input Bar
  const micPct = Math.min(100, Math.max(0, ((gainToDb(meters.mic.peak) + 54) / 54) * 100));
  $('micMeterFill').style.width = `${engine.micStream ? micPct : 0}%`;

  // Stereo VU Meters
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

  // Vocal Compressor Gain Reduction Meter
  const gr = meters.vocalCompGR;
  $('vocalGrBar').style.width = `${Math.min(100, (gr / 18) * 100)}%`;
  $('vocalGrVal').textContent = `-${gr.toFixed(1)} dB`;

  requestAnimationFrame(animationLoop);
}

// ==========================================================================
// Initialize Studio
// ==========================================================================
initDemoBeatsAndPresets();
syncControlsFromState();
drawEqCurve($('eqCurveCanvas'), engine);
window.addEventListener('resize', () => {
  if ($('panel-vocal-fx').classList.contains('active')) {
    drawEqCurve($('eqCurveCanvas'), engine);
  }
});
requestAnimationFrame(animationLoop);
