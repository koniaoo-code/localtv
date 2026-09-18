// @ts-nocheck
/* LOCAL TV — Управление видеоплеером, чатом, туннелями и GitHub Pages */

let playerInstance = null;
let currentEngine = null; // 'mpegts' | 'hls'
let isStreamLive = false;
let currentStreamKey = 'LOCALTV';
let ngrokPublicUrl = null;
let publicStreamOrigin = null;
let publicRtmpHost = 'rtmp://127.0.0.1:1935/live';
let eventSourceInstance = null;

// Определение, запущен ли плеер на GitHub Pages или внешнем статическом домене
const isExternalHost = window.location.hostname !== 'localhost' && 
                       window.location.hostname !== '127.0.0.1' && 
                       !window.location.hostname.startsWith('192.168.');

// Элементы интерфейса
const videoEl = document.getElementById('tv-player');
const offlineScreen = document.getElementById('offline-screen');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const viewerCountNum = document.getElementById('viewer-count-num');
const liveClock = document.getElementById('live-clock');
const ngrokBanner = document.getElementById('ngrok-banner');
const ghBanner = document.getElementById('gh-banner');
const playerEngineBadge = document.getElementById('player-engine-badge');

// Элементы управления
const btnPlayToggle = document.getElementById('btn-play-toggle');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnMuteToggle = document.getElementById('btn-mute-toggle');
const iconVolOn = document.getElementById('icon-vol-on');
const iconVolOff = document.getElementById('icon-vol-off');
const volumeSlider = document.getElementById('volume-slider');
const btnLiveSync = document.getElementById('btn-live-sync');
const btnFullscreen = document.getElementById('btn-fullscreen');
const reactionsLayer = document.getElementById('reactions-layer');
const chatMessages = document.getElementById('chat-messages');

// Часы
setInterval(() => {
  const now = new Date();
  if (liveClock) liveClock.textContent = now.toLocaleTimeString();
}, 1000);

let selectedEngine = 'hls';
let statsTimer = null;
let lastBytes = 0;
let lastTime = Date.now();

// ================= ОПРЕДЕЛЕНИЕ АДРЕСА СТРИМА =================
function getActiveStreamOrigin() {
  // 1. URL параметр: ?stream=https://... или ?server=https://...
  const urlParams = new URLSearchParams(window.location.search);
  const paramUrl = urlParams.get('stream') || urlParams.get('server');
  if (paramUrl && paramUrl.trim()) {
    let clean = paramUrl.trim().replace(/\/+$/, '');
    try { localStorage.setItem('localtv_stream_server', clean); } catch (e) {}
    return clean;
  }

  // 2. Сохраненное значение в браузере зрителя
  try {
    const saved = localStorage.getItem('localtv_stream_server');
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, '');
  } catch (e) {}

  // 3. Конфигурация из public/config.js
  if (window.LOCALTV_CONFIG && window.LOCALTV_CONFIG.streamServerUrl && window.LOCALTV_CONFIG.streamServerUrl.trim()) {
    return window.LOCALTV_CONFIG.streamServerUrl.trim().replace(/\/+$/, '');
  }

  // 4. Динамически полученный публичный URL от SSE или ngrok
  if (publicStreamOrigin) return publicStreamOrigin.replace(/\/+$/, '');
  if (ngrokPublicUrl) return ngrokPublicUrl.replace(/\/+$/, '');

  // 5. По умолчанию
  if (isExternalHost) {
    return ''; // Требуется настройка на GitHub Pages
  }
  return window.location.origin;
}

function showPlayPrompt() {
  const overlay = document.getElementById('play-prompt-overlay');
  if (overlay && isStreamLive && videoEl && videoEl.paused) {
    overlay.classList.remove('hidden');
  }
}

function hidePlayPrompt() {
  const overlay = document.getElementById('play-prompt-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function handleStartPlayback() {
  if (videoEl) {
    videoEl.muted = false;
    updateVolumeIcons();
    videoEl.play().then(() => {
      hidePlayPrompt();
    }).catch(() => {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
      hidePlayPrompt();
    });
  }
}

function switchEngine(engine) {
  selectedEngine = engine;
  const btnFlv = document.getElementById('btn-engine-flv');
  const btnHls = document.getElementById('btn-engine-hls');
  if (btnFlv && btnHls) {
    btnFlv.classList.toggle('active', engine === 'flv');
    btnHls.classList.toggle('active', engine === 'hls');
  }
  showToast(`Режим: ${engine === 'hls' ? '📼 HLS (playlist.m3u8)' : '⚡ HTTP-FLV (Прямой поток)'}`);
  initPlayer();
}

// ================= ИНИЦИАЛИЗАЦИЯ ПЛЕЕРА =================
function initPlayer() {
  destroyPlayer();

  const origin = getActiveStreamOrigin();

  // Если на GitHub Pages еще не указан стрим-сервер
  if (isExternalHost && !origin) {
    console.warn('[LOCAL TV] На GitHub Pages не настроен адрес домашнего стрим-сервера.');
    if (ghBanner) ghBanner.classList.remove('hidden');
    if (statusText) statusText.textContent = 'УКАЖИТЕ ИСТОЧНИК ПОТОКА';
    return;
  } else {
    if (ghBanner) ghBanner.classList.add('hidden');
  }

  const fullFlvUrl = origin + `/live/${currentStreamKey}.flv`;
  const fullHlsUrl = origin + '/playlist.m3u8';

  const directUrlEl = document.getElementById('stream-direct-url');
  if (directUrlEl) directUrlEl.textContent = selectedEngine === 'hls' ? fullHlsUrl : fullFlvUrl;

  if (videoEl) {
    videoEl.setAttribute('data-stream-engine', selectedEngine.toUpperCase());
    videoEl.setAttribute('data-stream-url', selectedEngine === 'hls' ? fullHlsUrl : fullFlvUrl);
    videoEl.setAttribute('data-stream-status', 'CONNECTING');
  }

  console.log(
    `%c📡 [LOCAL TV] ПОДКЛЮЧЕНИЕ К ПОТОКУ %c\n` +
    `▶ Движок: ${selectedEngine.toUpperCase()}\n` +
    `▶ Источник: ${origin}\n` +
    `▶ Прямой URL HLS: ${fullHlsUrl}`,
    'background: #3b82f6; color: white; font-weight: bold; font-size: 13px; padding: 4px 8px; border-radius: 4px;',
    'color: #38bdf8; font-size: 12px;'
  );

  // 1. РЕЖИМ HLS (Hls.js)
  if (selectedEngine === 'hls' && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 15,
      maxMaxBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
      backBufferLength: 10,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 500
    });

    hls.loadSource(fullHlsUrl);
    hls.attachMedia(videoEl);

    let totalBytes = 0;
    let chunkCount = 0;

    window.STREAM = {
      engine: 'HLS',
      url: fullHlsUrl,
      hls,
      video: videoEl,
      chunks: [],
      getBytes: () => totalBytes,
      getStats: () => ({
        engine: 'HLS (.m3u8 + .ts)',
        url: fullHlsUrl,
        chunksLoaded: chunkCount,
        totalMb: (totalBytes / (1024 * 1024)).toFixed(2) + ' MB'
      }),
      switchEngine
    };

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      console.log('%c✅ [HLS MANIFEST] playlist.m3u8 разобран, запуск воспроизведения...', 'color: #22c55e; font-weight: bold;');
      if (videoEl) {
        videoEl.play().catch(() => {
          videoEl.muted = true;
          updateVolumeIcons();
          videoEl.play().catch(() => showPlayPrompt());
        });
      }
    });

    hls.on(window.Hls.Events.FRAG_LOADED, (event, data) => {
      chunkCount++;
      const bytes = data.frag.stats.loaded || data.frag.stats.total || 0;
      totalBytes += bytes;

      const networkLiveBadge = document.getElementById('inspector-network-live');
      if (networkLiveBadge) {
        networkLiveBadge.textContent = `Пакет #${chunkCount} • +${(bytes / 1024).toFixed(0)} KB`;
        networkLiveBadge.classList.add('pulse');
        setTimeout(() => networkLiveBadge.classList.remove('pulse'), 800);
      }
    });

    hls.on(window.Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case window.Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            destroyPlayer();
            break;
        }
      }
    });

    playerInstance = hls;
    currentEngine = 'hls';
    updateEngineBadge('HLS 2.0s', '#38bdf8');
    startStatsMonitoring('hls');
    return;
  }

  // 2. Встроенный HLS (Safari / iOS)
  if (selectedEngine === 'hls' && videoEl && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = fullHlsUrl;
    videoEl.addEventListener('loadedmetadata', () => {
      videoEl.play().catch(() => {
        videoEl.muted = true;
        videoEl.play().catch(() => showPlayPrompt());
      });
    });
    playerInstance = { destroy: () => { videoEl.src = ''; } };
    currentEngine = 'hls-native';
    updateEngineBadge('Native HLS', '#38bdf8');
    return;
  }

  // 3. HTTP-FLV (mpegts.js)
  if (window.mpegts && window.mpegts.isSupported()) {
    try {
      const flvPlayer = window.mpegts.createPlayer({
        type: 'flv',
        isLive: true,
        url: fullFlvUrl,
        hasAudio: true,
        hasVideo: true,
        cors: true
      }, {
        enableWorker: true,
        enableStashBuffer: false,
        stashInitialSize: 128,
        liveBufferLatencyChasing: true,
        autoCleanupSourceBuffer: true
      });

      flvPlayer.attachMediaElement(videoEl);
      flvPlayer.load();

      flvPlayer.on(window.mpegts.Events.ERROR, () => {
        console.log('[MPEGTS] Сбой прямого FLV. Авто-переключение на HLS...');
        switchEngine('hls');
      });

      playerInstance = flvPlayer;
      currentEngine = 'mpegts';
      updateEngineBadge('FLV 0.5s', '#eab308');
      startStatsMonitoring('mpegts');

      videoEl.play().catch(() => {
        videoEl.muted = true;
        updateVolumeIcons();
        videoEl.play().catch(() => showPlayPrompt());
      });
      return;
    } catch (err) {
      console.warn('Ошибка инициализации FLV:', err);
    }
  }

  // Резервный HTML5 source
  if (videoEl) {
    videoEl.src = fullFlvUrl;
    videoEl.play().catch(() => {});
  }
}

function destroyPlayer() {
  stopStatsMonitoring();
  if (playerInstance) {
    try {
      if (typeof playerInstance.destroy === 'function') playerInstance.destroy();
    } catch (e) {}
    playerInstance = null;
  }
  if (videoEl) {
    videoEl.removeAttribute('src');
    videoEl.load();
  }
  currentEngine = null;
}

function updateEngineBadge(label, color) {
  if (playerEngineBadge) {
    playerEngineBadge.textContent = label;
    playerEngineBadge.style.borderColor = color;
    playerEngineBadge.style.color = color;
  }
}

function startStatsMonitoring(type) {
  stopStatsMonitoring();
  lastBytes = 0;
  lastTime = Date.now();

  statsTimer = setInterval(() => {
    if (!videoEl) return;
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    if (dt <= 0) return;

    let currentBytes = 0;
    if (type === 'mpegts' && playerInstance && playerInstance.statisticsInfo) {
      currentBytes = playerInstance.statisticsInfo.totalSegmentBytes || 0;
    } else if (window.STREAM && window.STREAM.getBytes) {
      currentBytes = window.STREAM.getBytes();
    }

    const diff = currentBytes - lastBytes;
    if (diff > 0) {
      const kbps = Math.round((diff * 8) / dt / 1000);
      const bitrateEl = document.getElementById('inspector-bitrate');
      if (bitrateEl) bitrateEl.textContent = `${kbps} Kbps`;
    }
    lastBytes = currentBytes;
    lastTime = now;
  }, 1000);
}

function stopStatsMonitoring() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function updateStreamStatus(live, key) {
  isStreamLive = live;
  if (key) currentStreamKey = key;

  if (statusBadge && statusText && offlineScreen) {
    if (live) {
      statusBadge.className = 'status-badge live';
      statusText.textContent = '● В ЭФИРЕ (LIVE)';
      offlineScreen.classList.add('hidden');
      if (!playerInstance) initPlayer();
    } else {
      statusBadge.className = 'status-badge offline';
      statusText.textContent = 'ОЖИДАНИЕ СИГНАЛА';
      offlineScreen.classList.remove('hidden');
    }
  }
  updateLinks();
}

// ================= УПРАВЛЕНИЕ ВИДЕО =================
if (btnPlayToggle && videoEl) {
  btnPlayToggle.addEventListener('click', () => {
    if (videoEl.paused) {
      videoEl.play();
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
    } else {
      videoEl.pause();
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    }
  });
}

if (btnMuteToggle && videoEl) {
  btnMuteToggle.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
    updateVolumeIcons();
  });
}

if (volumeSlider && videoEl) {
  volumeSlider.addEventListener('input', (e) => {
    videoEl.volume = parseFloat(e.target.value);
    videoEl.muted = (videoEl.volume === 0);
    updateVolumeIcons();
  });
}

function updateVolumeIcons() {
  if (!videoEl || !iconVolOn || !iconVolOff) return;
  if (videoEl.muted || videoEl.volume === 0) {
    iconVolOn.classList.add('hidden');
    iconVolOff.classList.remove('hidden');
    if (volumeSlider) volumeSlider.value = 0;
  } else {
    iconVolOn.classList.remove('hidden');
    iconVolOff.classList.add('hidden');
    if (volumeSlider) volumeSlider.value = videoEl.volume;
  }
}

if (btnFullscreen && videoEl) {
  btnFullscreen.addEventListener('click', () => {
    const wrapper = document.querySelector('.player-wrapper');
    if (!document.fullscreenElement) {
      (wrapper || videoEl).requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

if (btnLiveSync) {
  btnLiveSync.addEventListener('click', () => {
    showToast('Синхронизация с живым потоком...');
    initPlayer();
  });
}

// ================= РЕАКЦИИ И ЧАТ =================
function sendReaction(emoji) {
  spawnFloatingReaction(emoji);
  const origin = getActiveStreamOrigin();
  if (origin) {
    fetch(origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: emoji })
    }).catch(() => {});
  }
}

function spawnFloatingReaction(emoji) {
  if (!reactionsLayer) return;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = `${Math.random() * 80 + 10}%`;
  reactionsLayer.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function handleSendChat(event) {
  event.preventDefault();
  const inputUser = document.getElementById('chat-user-input');
  const inputText = document.getElementById('chat-text-input');
  const user = (inputUser && inputUser.value.trim()) ? inputUser.value.trim() : 'Зритель';
  const text = inputText ? inputText.value.trim() : '';

  if (!text) return;

  const origin = getActiveStreamOrigin();
  if (origin) {
    fetch(origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, text })
    }).then(() => {
      if (inputText) inputText.value = '';
    }).catch(() => {
      // Локальный показ, если офлайн
      appendChatMessage({ id: Date.now(), user, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      if (inputText) inputText.value = '';
    });
  }
}

function appendChatMessage(msg) {
  if (!chatMessages) return;
  const item = document.createElement('div');
  item.className = 'chat-message';
  item.innerHTML = `
    <span class="chat-time">${escapeHtml(msg.time || '')}</span>
    <span class="chat-author">${escapeHtml(msg.user || 'Зритель')}:</span>
    <span class="chat-text">${escapeHtml(msg.text || '')}</span>
  `;
  chatMessages.appendChild(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ================= ПОДКЛЮЧЕНИЕ SSE =================
function connectEvents() {
  if (eventSourceInstance) {
    try { eventSourceInstance.close(); } catch (e) {}
    eventSourceInstance = null;
  }

  const origin = getActiveStreamOrigin();
  if (!origin) return;

  try {
    const es = new EventSource(origin + '/api/events');
    eventSourceInstance = es;

    es.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      updateStreamStatus(data.isLive, data.streamKey);
      if (data.viewers && viewerCountNum) viewerCountNum.textContent = data.viewers;
      if (data.messages && chatMessages) {
        chatMessages.innerHTML = '';
        data.messages.forEach(appendChatMessage);
      }
      if (data.publicRtmpUrl) publicRtmpHost = data.publicRtmpUrl;
      if (data.publicHttpUrl && !isExternalHost) publicStreamOrigin = data.publicHttpUrl;
      updateLinks();
    });

    es.addEventListener('tunnel_update', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.publicRtmpUrl) publicRtmpHost = data.publicRtmpUrl;
        if (data.publicHttpUrl && !isExternalHost) publicStreamOrigin = data.publicHttpUrl;
        updateLinks();
      } catch (err) {}
    });

    es.addEventListener('stream_status', (e) => {
      const data = JSON.parse(e.data);
      updateStreamStatus(data.isLive, data.streamKey);
    });

    es.addEventListener('viewers_count', (e) => {
      const data = JSON.parse(e.data);
      if (viewerCountNum) viewerCountNum.textContent = data.viewers;
    });

    es.addEventListener('chat_message', (e) => {
      appendChatMessage(JSON.parse(e.data));
    });

    es.addEventListener('reaction', (e) => {
      const data = JSON.parse(e.data);
      if (data.reaction) spawnFloatingReaction(data.reaction);
    });

    es.onerror = () => {
      // Игнорируем штатные реконнекты SSE
    };
  } catch (e) {
    console.warn('[SSE] Ошибка подключения событий:', e);
  }
}

// Опрос /api/status и проверка плейлиста
async function fetchStatus() {
  const origin = getActiveStreamOrigin();
  if (!origin) return;

  try {
    const res = await fetch(origin + '/api/status?_t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('status HTTP ' + res.status);
    const data = await res.json();

    if (data.isLive) {
      if (!isStreamLive || !playerInstance) {
        updateStreamStatus(true, data.streamKey);
      }
    } else {
      // Проверяем index.m3u8 напрямую
      try {
        const checkRes = await fetch(origin + '/playlist.m3u8?_t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
        if (checkRes.ok && !isStreamLive) {
          updateStreamStatus(true, data.streamKey || 'LOCALTV');
        } else if (!checkRes.ok && isStreamLive) {
          updateStreamStatus(false, data.streamKey);
        }
      } catch (e) {
        if (isStreamLive) updateStreamStatus(false, data.streamKey);
      }
    }

    if (data.viewers && viewerCountNum) viewerCountNum.textContent = data.viewers;
    if (data.boreRtmpUrl) publicRtmpHost = data.boreRtmpUrl;
    updateLinks();
  } catch (err) {
    // В случае сетевой ошибки просто проверяем HEAD плейлиста
    try {
      const checkRes = await fetch(origin + '/playlist.m3u8?_t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      if (checkRes.ok && !isStreamLive) updateStreamStatus(true, 'LOCALTV');
    } catch (e) {}
  }
}

// ================= ОБНОВЛЕНИЕ ССЫЛОК И ПОЛЕЙ В ИНТЕРФЕЙСЕ =================
function updateLinks() {
  const origin = getActiveStreamOrigin() || 'http://localhost:8000';
  const rtmpLocal = 'rtmp://127.0.0.1:1935/live';
  const rtmpBore = publicRtmpHost || 'rtmp://bore.pub:64897/live';
  const hls = `${origin}/playlist.m3u8`;
  const flv = `${origin}/live/${currentStreamKey}.flv`;

  const obsLocalEl = document.getElementById('obs-local-url');
  if (obsLocalEl) obsLocalEl.textContent = rtmpLocal;

  const obsBoreEl = document.getElementById('obs-bore-url');
  if (obsBoreEl) obsBoreEl.textContent = rtmpBore;

  const hlsEl = document.getElementById('share-hls-url');
  const flvEl = document.getElementById('share-flv-url');
  const webEl = document.getElementById('share-web-url');
  const directEl = document.getElementById('stream-direct-url');

  if (hlsEl) hlsEl.value = hls;
  if (flvEl) flvEl.value = flv;
  if (webEl) webEl.value = origin;
  if (directEl) directEl.textContent = selectedEngine === 'flv' ? flv : hls;

  // Ссылка для зрителей на GitHub Pages
  const ghShareInput = document.getElementById('share-gh-pages-url');
  if (ghShareInput) {
    const currentBase = window.location.href.split('?')[0];
    ghShareInput.value = `${currentBase}?stream=${encodeURIComponent(origin)}`;
  }

  // Обновление плашки текущего источника
  const currentSourceDisplay = document.getElementById('current-source-display');
  if (currentSourceDisplay) {
    currentSourceDisplay.textContent = origin || 'Не настроен (нажмите ⚙️)';
  }
}

// ================= МОДАЛЬНОЕ ОКНО НАСТРОЙКИ ИСТОЧНИКА ДЛЯ GITHUB PAGES =================
function openStreamSourceModal() {
  const modal = document.getElementById('modal-stream-source');
  const input = document.getElementById('input-stream-source');
  if (input) input.value = getActiveStreamOrigin();
  if (modal) modal.classList.remove('hidden');
}

function closeStreamSourceModal() {
  const modal = document.getElementById('modal-stream-source');
  if (modal) modal.classList.add('hidden');
}

function handleSaveStreamSource(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('input-stream-source');
  let val = (input ? input.value : '').trim().replace(/\/+$/, '');

  if (!val) {
    localStorage.removeItem('localtv_stream_server');
    showToast('Сброшено на авто-определение');
  } else {
    if (!val.startsWith('http://') && !val.startsWith('https://')) {
      val = 'https://' + val;
    }
    try { localStorage.setItem('localtv_stream_server', val); } catch (e) {}
    showToast(`Сохранено: ${val}`);
  }

  closeStreamSourceModal();
  initPlayer();
  connectEvents();
  fetchStatus();
  updateLinks();
}

// Привязка ngrok authtoken
async function handleSetToken(event) {
  event.preventDefault();
  const tokenVal = document.getElementById('input-token-val').value.trim();
  const btn = document.getElementById('btn-save-token');
  if (!tokenVal) return;

  btn.disabled = true;
  btn.textContent = 'Сохранение...';

  const origin = getActiveStreamOrigin();
  try {
    const res = await fetch((origin || '') + '/api/set-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenVal })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('🎉 Токен сохранен! Туннель запускается...');
      document.getElementById('input-token-val').value = '';
      setTimeout(fetchStatus, 2000);
    } else {
      alert('Ошибка: ' + (data.error || 'Не удалось сохранить'));
    }
  } catch (e) {
    alert('Ошибка при отправке токена на сервер');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить и включить туннель';
  }
}

// Табы
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

  const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (activeBtn) activeBtn.classList.add('active');

  const targetPane = document.getElementById(tabId);
  if (targetPane) targetPane.classList.add('active');
}

// Буфер обмена
function copyInput(inputId) {
  const input = document.getElementById(inputId);
  if (input && input.value) {
    navigator.clipboard.writeText(input.value).then(() => {
      showToast('Ссылка скопирована!');
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      showToast('Ссылка скопирована!');
    });
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Скопировано: ${text}`);
  }).catch(() => {
    showToast(`Скопировано: ${text}`);
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

// Запуск при старте
window.addEventListener('DOMContentLoaded', () => {
  updateLinks();
  initPlayer();
  connectEvents();
  fetchStatus();
  setInterval(fetchStatus, 4000);
});
