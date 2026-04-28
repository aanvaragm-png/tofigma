'use strict';

const crypto = require('crypto');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const maxItemsPerSession = Number(process.env.MAX_ITEMS_PER_SESSION || 100);
const itemTtlMs = Number(process.env.ITEM_TTL_MS || 24 * 60 * 60 * 1000);

const queues = new Map();

app.use(express.json({ limit: process.env.JSON_LIMIT || '15mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.get('/health', (req, res) => {
  cleanupExpiredItems();
  res.json({
    ok: true,
    name: 'Pinterest to Figma bridge',
    url: BASE_URL,
    pending: getPendingCount()
  });
});

app.post('/api/images', (req, res) => {
  const { sessionId, url, imageData, mimeType, pageUrl, title } = req.body || {};
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedSessionId) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  if (!isValidImagePayload(url, imageData)) {
    res.status(400).json({ error: 'image_required' });
    return;
  }

  cleanupExpiredItems();

  const item = {
    id: crypto.randomUUID(),
    sessionId: normalizedSessionId,
    url: typeof url === 'string' ? url : '',
    imageData: typeof imageData === 'string' ? imageData : '',
    mimeType: typeof mimeType === 'string' ? mimeType : 'image/png',
    pageUrl: typeof pageUrl === 'string' ? pageUrl : '',
    title: typeof title === 'string' ? title.slice(0, 200) : '',
    createdAt: new Date().toISOString(),
    status: 'queued'
  };

  const queue = queues.get(normalizedSessionId) || [];
  queue.unshift(item);

  if (queue.length > maxItemsPerSession) {
    queue.length = maxItemsPerSession;
  }

  queues.set(normalizedSessionId, queue);

  res.status(201).json({ ok: true, id: item.id });
});

app.get('/api/images', (req, res) => {
  const sessionId = normalizeSessionId(req.query.sessionId);

  if (!sessionId) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  cleanupExpiredItems();

  const items = (queues.get(sessionId) || []).filter((item) => item.status === 'queued');
  res.json({ ok: true, items });
});

app.post('/api/images/:id/ack', (req, res) => {
  const id = req.params.id;
  const sessionId = normalizeSessionId(req.body && req.body.sessionId);

  if (!sessionId) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  const queue = queues.get(sessionId) || [];
  const index = queue.findIndex((item) => item.id === id);

  if (index === -1) {
    res.status(404).json({ error: 'image_not_found' });
    return;
  }

  queue.splice(index, 1);
  queues.set(sessionId, queue);

  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`Pinterest Figma backend listening on port ${PORT}`);
});

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{6,80}$/.test(trimmed) ? trimmed : '';
}

function isValidImagePayload(url, imageData) {
  const hasUrl = typeof url === 'string' && /^https?:\/\//i.test(url);
  const hasImageData = typeof imageData === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageData);
  return hasUrl || hasImageData;
}

function cleanupExpiredItems() {
  const now = Date.now();

  for (const [sessionId, queue] of queues.entries()) {
    const freshQueue = queue.filter((item) => {
      const createdAt = Date.parse(item.createdAt);
      return Number.isFinite(createdAt) && now - createdAt < itemTtlMs;
    });

    if (freshQueue.length === 0) {
      queues.delete(sessionId);
    } else {
      queues.set(sessionId, freshQueue);
    }
  }
}

function getPendingCount() {
  let count = 0;

  for (const queue of queues.values()) {
    count += queue.filter((item) => item.status === 'queued').length;
  }

  return count;
}
