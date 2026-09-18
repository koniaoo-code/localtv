// @ts-nocheck
/* LOCAL TV — Плеер и Чат */

let hlsPlayer = null;
let isStreamLive = false;
let currentStreamKey = 'LOCALTV';

const videoEl = document.getElementById('tv-player');
const offlineScreen = document.getElementById('offline-screen');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const liveClock = document.getElementById('live-clock');
const viewerTag = document.getElementById('viewer-count-tag');
const reactionsLayer = document.getElementById('reactions-layer');
const chatMessages = document.getElementById('chat-messages');

const btnPlayToggle = document.getElementById('btn-play-toggle');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnMuteToggle = document.getElementById('btn-mute-toggle');
const iconVolOn = document.getElementById('icon-vol-on');
const iconVolOff = document.getElementById('icon-vol-off');
const volumeSlider = document.getElementById('volume-slider');
const btnFullscreen = document.getElementById('btn-fullscreen');

// Живые часы
setInterval(() => {
  const now = new Date();
  if (liveClock) liveClock.textContent = now.toLocaleTimeString();
}, 1000);

// Получение адреса стрим-сервера
function getStreamOrigin() {
  const urlParams = new URLSearchParams(window.location.search);
  const paramUrl = urlParams.get('stream') || urlParams.get('server');
  if (paramUrl && paramUrl.trim()) {
    let clean = paramUrl.trim().replace(/\/+$/, '');
    try { localStorage.setItem('localtv_stream_server', clean); } catch (e) {}
    return clean;
  }

  try {
    const saved = localStorage.getItem('localtv_stream_server');
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, '');
  } catch (e) {}

  if (window.LOCALTV_CONFIG && window.LOCALTV_CONFIG.streamServerUrl && window.LOCALTV_CONFIG.streamServerUrl.trim()) {
    return window.LOCALTV_CONFIG.streamServerUrl.trim().replace(/\/+$/, '');
  }

  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return '';
  }
  return window.location.origin;
}

// Запуск воспроизведения со звуком
function handleStartPlayback() {
  if (videoEl) {
    videoEl.muted = false;
    updateVolumeIcons();
    videoEl.play().catch(() => {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    });
    const promptEl = document.getElementById('play-prompt-overlay');
    if (promptEl) promptEl.classList.add('hidden');
  }
}

// Инициализация видеоплеера
function initPlayer() {
  if (hlsPlayer) {
    try { hlsPlayer.destroy(); } catch (e) {}
    hlsPlayer = null;
  }

  const origin = getStreamOrigin();
  if (!origin) return;

  const hlsUrl = origin + '/playlist.m3u8';

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 10,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (videoEl) {
        videoEl.play().catch(() => {
          videoEl.muted = true;
          updateVolumeIcons();
          videoEl.play().catch(() => {
            const promptEl = document.getElementById('play-prompt-overlay');
            if (promptEl) promptEl.classList.remove('hidden');
          });
        });
      }
    });

    hls.on(window.Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
        }
      }
    });

    hlsPlayer = hls;
    return;
  }

  if (videoEl && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = hlsUrl;
    videoEl.play().catch(() => {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    });
  }
}

function updateStatus(live) {
  isStreamLive = live;
  if (statusBadge && statusText && offlineScreen) {
    if (live) {
      statusBadge.className = 'status-badge live';
      statusText.textContent = 'В ЭФИРЕ';
      offlineScreen.classList.add('hidden');
      if (!hlsPlayer) initPlayer();
    } else {
      statusBadge.className = 'status-badge offline';
      statusText.textContent = 'ОЖИДАНИЕ';
      offlineScreen.classList.remove('hidden');
    }
  }
}

// Управление плеером
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

// Реакции
function sendReaction(emoji) {
  spawnReaction(emoji);
  const origin = getStreamOrigin();
  if (origin) {
    fetch(origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: emoji })
    }).catch(() => {});
  }
}

function spawnReaction(emoji) {
  if (!reactionsLayer) return;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = `${Math.random() * 80 + 10}%`;
  reactionsLayer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// Чат
function handleSendChat(event) {
  event.preventDefault();
  const inputUser = document.getElementById('chat-user-input');
  const inputText = document.getElementById('chat-text-input');
  const user = (inputUser && inputUser.value.trim()) ? inputUser.value.trim() : 'Зритель';
  const text = inputText ? inputText.value.trim() : '';
  if (!text) return;

  const origin = getStreamOrigin();
  if (origin) {
    fetch(origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, text })
    }).catch(() => {});
  }
  if (inputText) inputText.value = '';
}

function appendMessage(msg) {
  if (!chatMessages) return;
  const el = document.createElement('div');
  el.className = 'chat-message';
  el.innerHTML = `
    <span class="chat-time">${msg.time || ''}</span>
    <span class="chat-author">${escapeHtml(msg.user || 'Зритель')}:</span>
    <span class="chat-text">${escapeHtml(msg.text || '')}</span>
  `;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// События сервера (SSE)
function connectEvents() {
  const origin = getStreamOrigin();
  if (!origin) return;

  try {
    const es = new EventSource(origin + '/api/events');

    es.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      updateStatus(data.isLive);
      if (data.viewers && viewerTag) viewerTag.textContent = `${data.viewers} онлайн`;
      if (data.messages && chatMessages) {
        chatMessages.innerHTML = '';
        data.messages.forEach(appendMessage);
      }
    });

    es.addEventListener('stream_status', (e) => {
      const data = JSON.parse(e.data);
      updateStatus(data.isLive);
    });

    es.addEventListener('viewers_count', (e) => {
      const data = JSON.parse(e.data);
      if (viewerTag) viewerTag.textContent = `${data.viewers} онлайн`;
    });

    es.addEventListener('chat_message', (e) => {
      appendMessage(JSON.parse(e.data));
    });

    es.addEventListener('reaction', (e) => {
      const data = JSON.parse(e.data);
      if (data.reaction) spawnReaction(data.reaction);
    });
  } catch (e) {}
}

async function checkStatus() {
  const origin = getStreamOrigin();
  if (!origin) return;

  try {
    const res = await fetch(origin + '/api/status?_t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      updateStatus(data.isLive);
      if (data.viewers && viewerTag) viewerTag.textContent = `${data.viewers} онлайн`;
    }
  } catch (e) {
    try {
      const probe = await fetch(origin + '/playlist.m3u8?_t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      if (probe.ok) updateStatus(true);
    } catch (err) {}
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initPlayer();
  connectEvents();
  checkStatus();
  setInterval(checkStatus, 4000);
});
