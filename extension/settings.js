'use strict';

const DEFAULT_BACKEND_URL = 'https://pinterest-to-figma.onrender.com';

const backendUrlInput = document.getElementById('backendUrl');
const sessionIdInput = document.getElementById('sessionId');
const showPinterestButtonsInput = document.getElementById('showPinterestButtons');
const saveButton = document.getElementById('save');
const regenerateButton = document.getElementById('regenerate');
const statusNode = document.getElementById('status');

loadSettings();

saveButton.addEventListener('click', saveSettings);
regenerateButton.addEventListener('click', () => {
  sessionIdInput.value = createSessionId();
  saveSettings();
});

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    backendUrl: '',
    sessionId: '',
    showPinterestButtons: true
  });
  backendUrlInput.value = settings.backendUrl || DEFAULT_BACKEND_URL;
  sessionIdInput.value = settings.sessionId || createSessionId();

  if (showPinterestButtonsInput) {
    showPinterestButtonsInput.checked = settings.showPinterestButtons !== false;
  }
}

async function saveSettings() {
  const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, '');
  const sessionId = sessionIdInput.value.trim();

  if (!backendUrl || !/^https?:\/\//i.test(backendUrl)) {
    setStatus('Backend URL must start with http:// or https://');
    return;
  }

  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(sessionId)) {
    setStatus('Session ID must be 6-80 letters, numbers, _ or -');
    return;
  }

  await chrome.storage.local.set({
    backendUrl,
    sessionId,
    showPinterestButtons: showPinterestButtonsInput ? showPinterestButtonsInput.checked : true
  });
  setStatus('Saved.');
}

function setStatus(text) {
  statusNode.textContent = text;
}

function createSessionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
