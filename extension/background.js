'use strict';

const LOG_PREFIX = '[PinterestToFigma]';
const DEFAULT_BACKEND_URL = 'https://pinterest-to-figma.onrender.com';
const DEFAULT_SETTINGS = {
  backendUrl: DEFAULT_BACKEND_URL,
  sessionId: ''
};

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get(['backendUrl', 'sessionId', 'showPinterestButtons']);
  const updates = {};

  if (!settings.backendUrl) {
    updates.backendUrl = DEFAULT_BACKEND_URL;
  }

  if (!settings.sessionId) {
    updates.sessionId = createSessionId();
  }

  if (settings.showPinterestButtons === undefined) {
    updates.showPinterestButtons = true;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['CAPTURE_IMAGE', 'PIN_IMAGE'].includes(message.type)) {
    return false;
  }

  const payload = normalizeCaptureMessage(message);

  debug(`received ${message.type} message`, {
    tabId: sender && sender.tab ? sender.tab.id : '',
    url: payload.imageUrl
  });

  handleCaptureImage(payload)
    .then((result) => {
      debug('send to backend success', result);
      sendResponse(result);
    })
    .catch((error) => {
      debug('send to backend error', error.message || 'send_failed');
      sendResponse({ ok: false, error: error.message || 'send_failed' });
    });

  return true;
});

async function handleCaptureImage(payload) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const backendUrl = normalizeBackendUrl(settings.backendUrl);
  const sessionId = normalizeSessionId(settings.sessionId);

  if (!backendUrl) {
    throw new Error('Set backend URL in the extension popup first.');
  }

  if (!sessionId) {
    throw new Error('Set a valid session ID in the extension popup first.');
  }

  const imageUrl = payload && payload.imageUrl;
  if (!imageUrl || !isSupportedImageUrl(imageUrl)) {
    throw new Error('Could not find a valid image URL.');
  }

  const imagePayload = {
    sessionId,
    url: /^https?:\/\//i.test(imageUrl) ? imageUrl : '',
    imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : '',
    pageUrl: payload.pageUrl || '',
    title: payload.title || ''
  };
  let usedFallbackUrl = false;

  if (/^data:image\//i.test(imageUrl)) {
    imagePayload.imageData = imageUrl;
    imagePayload.mimeType = getDataUrlMimeType(imageUrl);
  } else {
    try {
      const data = await fetchImageAsDataUrl(imageUrl);
      imagePayload.imageData = data.imageData;
      imagePayload.mimeType = data.mimeType;
    } catch (error) {
      debug('fetch failed, using fallback URL', error.message || 'image_fetch_failed');
      imagePayload.fetchWarning = error.message || 'image_fetch_failed';
      usedFallbackUrl = true;
    }
  }

  const response = await fetch(`${backendUrl}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(imagePayload)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Backend error ${response.status}`);
  }

  return {
    ok: true,
    id: body.id,
    warning: imagePayload.fetchWarning || '',
    fallback: usedFallbackUrl
  };
}

function normalizeCaptureMessage(message) {
  if (message.type === 'PIN_IMAGE') {
    return {
      imageUrl: message.payload && message.payload.url ? message.payload.url : '',
      pageUrl: message.payload && message.payload.pageUrl ? message.payload.pageUrl : '',
      title: message.payload && message.payload.title ? message.payload.title : ''
    };
  }

  return {
    imageUrl: message.imageUrl || '',
    pageUrl: message.pageUrl || '',
    title: message.title || ''
  };
}

async function fetchImageAsDataUrl(url) {
  const response = await fetch(url, { credentials: 'omit' });

  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`);
  }

  const blob = await response.blob();
  const mimeType = blob.type || 'image/png';
  const imageData = await blobToDataUrl(blob);

  return { imageData, mimeType };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

function normalizeBackendUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\/+$/, '');
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{6,80}$/.test(trimmed) ? trimmed : '';
}

function isSupportedImageUrl(url) {
  return /^https?:\/\//i.test(url) || /^data:image\//i.test(url);
}

function getDataUrlMimeType(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  return match ? match[1] : 'image/png';
}

function createSessionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function debug(message, details) {
  if (details === undefined) {
    console.debug(LOG_PREFIX, message);
    return;
  }

  console.debug(LOG_PREFIX, message, details);
}
