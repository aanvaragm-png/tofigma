'use strict';

const DEFAULT_BACKEND_URL = 'https://pinterest-to-figma.onrender.com';
const FRAME_PADDING = 24;
const ITEM_GAP = 16;
const MAX_DISPLAY_WIDTH = 320;
const MAX_DISPLAY_HEIGHT = 360;

figma.showUI(__html__, { width: 360, height: 460, themeColors: true });

figma.ui.onmessage = async (message) => {
  try {
    if (!message || !message.type) {
      return;
    }

    if (message.type === 'load-settings') {
      const settings = await figma.clientStorage.getAsync('settings');
      figma.ui.postMessage({
        type: 'settings-loaded',
        settings: {
          backendUrl: settings && settings.backendUrl ? settings.backendUrl : DEFAULT_BACKEND_URL,
          sessionId: settings && settings.sessionId ? settings.sessionId : ''
        }
      });
      return;
    }

    if (message.type === 'save-settings') {
      await figma.clientStorage.setAsync('settings', {
        backendUrl: normalizeBackendUrl(message.backendUrl),
        sessionId: normalizeSessionId(message.sessionId)
      });
      figma.ui.postMessage({ type: 'settings-saved' });
      return;
    }

    if (message.type === 'insert-image') {
      const node = await insertImage(message.item);
      figma.ui.postMessage({ type: 'inserted', id: message.item.id, nodeId: node.id });
      return;
    }
  } catch (error) {
    figma.ui.postMessage({
      type: 'error',
      id: message && message.item && message.item.id,
      message: error.message || 'Plugin error'
    });
  }
};

async function insertImage(item) {
  if (!item || !item.id) {
    throw new Error('Invalid image item.');
  }

  const bytes = dataUrlToBytes(item.imageData);
  const image = figma.createImage(bytes);
  const imageSize = await image.getSizeAsync();
  const displaySize = getDisplaySize(imageSize);
  const frame = getOrCreateReferencesFrame();
  const rect = figma.createRectangle();

  rect.name = item.title ? `Pinterest - ${item.title}` : 'Pinterest Reference';
  rect.resize(displaySize.width, displaySize.height);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash }];

  const position = getNextTilePosition(frame);
  rect.x = position.x;
  rect.y = position.y;
  frame.appendChild(rect);

  frame.resizeWithoutConstraints(
    Math.max(frame.width, position.x + rect.width + FRAME_PADDING),
    Math.max(frame.height, position.y + rect.height + FRAME_PADDING)
  );

  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);

  return rect;
}

function getOrCreateReferencesFrame() {
  const existing = figma.currentPage.findOne((node) => node.type === 'FRAME' && node.name === 'Pinterest References');

  if (existing && existing.type === 'FRAME') {
    return existing;
  }

  const frame = figma.createFrame();
  frame.name = 'Pinterest References';
  frame.resize(748, 520);
  frame.x = figma.viewport.center.x - frame.width / 2;
  frame.y = figma.viewport.center.y - frame.height / 2;
  frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.97, b: 0.98 } }];
  figma.currentPage.appendChild(frame);

  return frame;
}

function getDisplaySize(imageSize) {
  const sourceWidth = imageSize && imageSize.width > 0 ? imageSize.width : 220;
  const sourceHeight = imageSize && imageSize.height > 0 ? imageSize.height : 220;
  const scale = Math.min(MAX_DISPLAY_WIDTH / sourceWidth, MAX_DISPLAY_HEIGHT / sourceHeight, 1);

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function getNextTilePosition(frame) {
  const usableWidth = Math.max(MAX_DISPLAY_WIDTH, frame.width - FRAME_PADDING * 2);
  const columns = Math.max(1, Math.floor((usableWidth + ITEM_GAP) / (MAX_DISPLAY_WIDTH + ITEM_GAP)));
  const columnHeights = Array.from({ length: columns }, () => FRAME_PADDING);
  const imageChildren = frame.children.filter((node) => node.type === 'RECTANGLE');

  for (const child of imageChildren) {
    const columnIndex = Math.max(0, Math.min(columns - 1, Math.round((child.x - FRAME_PADDING) / (MAX_DISPLAY_WIDTH + ITEM_GAP))));
    columnHeights[columnIndex] = Math.max(columnHeights[columnIndex], child.y + child.height + ITEM_GAP);
  }

  const targetColumn = getShortestColumnIndex(columnHeights);

  return {
    x: FRAME_PADDING + targetColumn * (MAX_DISPLAY_WIDTH + ITEM_GAP),
    y: columnHeights[targetColumn]
  };
}

function getShortestColumnIndex(columnHeights) {
  let shortestIndex = 0;
  let shortestHeight = columnHeights[0];

  for (let index = 1; index < columnHeights.length; index += 1) {
    if (columnHeights[index] < shortestHeight) {
      shortestIndex = index;
      shortestHeight = columnHeights[index];
    }
  }

  return shortestIndex;
}

function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl)) {
    throw new Error('Image fetch failed: missing image data.');
  }

  const base64 = dataUrl.split(',')[1];
  const binary = base64Decode(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function base64Decode(value) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  let buffer;
  let chr1;
  let chr2;
  let chr3;
  let enc1;
  let enc2;
  let enc3;
  let enc4;
  let index = 0;

  while (index < value.length) {
    enc1 = chars.indexOf(value.charAt(index++));
    enc2 = chars.indexOf(value.charAt(index++));
    enc3 = chars.indexOf(value.charAt(index++));
    enc4 = chars.indexOf(value.charAt(index++));

    buffer = (enc1 << 18) | (enc2 << 12) | (enc3 << 6) | enc4;
    chr1 = (buffer >> 16) & 255;
    chr2 = (buffer >> 8) & 255;
    chr3 = buffer & 255;

    output += String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output += String.fromCharCode(chr2);
    }

    if (enc4 !== 64) {
      output += String.fromCharCode(chr3);
    }
  }

  return output;
}

function normalizeBackendUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{6,80}$/.test(trimmed) ? trimmed : '';
}
