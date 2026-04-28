'use strict';

const crypto = require('crypto');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const queue = [];

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
  res.json({
    ok: true,
    name: 'Pinterest to Figma bridge',
    url: BASE_URL,
    pending: queue.length
  });
});

app.post('/api/images', (req, res) => {
  const { sessionId, url, imageData, mimeType, pageUrl, title } = req.body || {};

  if (!isValidSessionId(sessionId)) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  if (!isValidImagePayload(url, imageData)) {
    res.status(400).json({ error: 'image_required' });
    return;
  }

  const item = {
    id: crypto.randomUUID(),
    sessionId: sessionId.trim(),
    url: typeof url === 'string' ? url : '',
    imageData: typeof imageData === 'string' ? imageData : '',
    mimeType: typeof mimeType === 'string' ? mimeType : 'image/png',
    pageUrl: typeof pageUrl === 'string' ? pageUrl : '',
    title: typeof title === 'string' ? title.slice(0, 200) : '',
    createdAt: new Date().toISOString()
  };

  queue.push(item);
  res.status(201).json({ ok: true, id: item.id });
});

app.get('/api/images', (req, res) => {
  const sessionId = req.query.sessionId;

  if (!isValidSessionId(sessionId)) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  const items = queue.filter((item) => item.sessionId === sessionId.trim());
  res.json({ ok: true, items });
});

app.post('/api/images/:id/ack', (req, res) => {
  const sessionId = req.body && req.body.sessionId;

  if (!isValidSessionId(sessionId)) {
    res.status(400).json({ error: 'invalid_session_id' });
    return;
  }

  const index = queue.findIndex((item) => item.id === req.params.id && item.sessionId === sessionId.trim());

  if (index === -1) {
    res.status(404).json({ error: 'image_not_found' });
    return;
  }

  queue.splice(index, 1);
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
  console.log(`Pinterest to Figma bridge listening on port ${PORT}`);
});

function isValidSessionId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(value.trim());
}

function isValidImagePayload(url, imageData) {
  const hasUrl = typeof url === 'string' && /^https?:\/\//i.test(url);
  const hasImageData = typeof imageData === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageData);
  return hasUrl || hasImageData;
}
