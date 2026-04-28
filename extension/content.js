'use strict';

const LOG_PREFIX = '[PinterestToFigma]';
const OVERLAY_ROOT_ID = 'pinterest-to-figma-overlay-root';
const TOAST_ID = 'pinterest-to-figma-toast';
const BUTTON_CLASS = 'pinterest-to-figma-add-button';
const MIN_IMAGE_SIZE = 180;
const SCAN_THROTTLE_MS = 1200;
const MAX_VISIBLE_BUTTONS = 40;
const MAX_BACKGROUND_PARENT_DEPTH = 8;

const trackedImages = new Map();

let overlayRoot = null;
let toastNode = null;
let toastTimer = 0;
let observer = null;
let pinterestOverlayEnabled = false;
let scanTimer = 0;
let lastScanAt = 0;
let positionFrame = 0;
let hoverFrame = 0;
let hoveredImage = null;
let pointerX = 0;
let pointerY = 0;

debug('content script loaded');
document.addEventListener('click', handleUniversalClick, true);
initPinterestOverlay();

async function initPinterestOverlay() {
  if (!isPinterestPage()) {
    debug('Pinterest overlay skipped: non-Pinterest page');
    return;
  }

  const settings = await chrome.storage.local.get({ showPinterestButtons: true });

  if (!settings.showPinterestButtons) {
    debug('Pinterest overlay disabled by settings');
    return;
  }

  startPinterestOverlay();
}

function startPinterestOverlay() {
  if (pinterestOverlayEnabled) {
    return;
  }

  pinterestOverlayEnabled = true;
  ensureOverlayRoot();
  scheduleScan('initial');

  observer = new MutationObserver(() => {
    scheduleScan('mutation');
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('scroll', handleViewportChange, { passive: true });
  window.addEventListener('resize', handleViewportChange, { passive: true });
  window.addEventListener('mousemove', handlePointerMove, { passive: true });
  window.addEventListener('mouseleave', clearHoveredImage, { passive: true });
  debug('Pinterest overlay enabled');
}

async function handleUniversalClick(event) {
  if (!event.shiftKey) {
    return;
  }

  const capture = findCaptureTarget(event);

  if (!capture || !capture.imageUrl) {
    debug('Shift+click ignored: no image found');
    showToast('No image found', 'error');
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  debug('Shift+click image captured', capture);
  debug('sending');
  showToast('Sending to Figma...', 'sending');

  try {
    const response = await sendImageToBackground(capture.imageUrl);

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Send failed');
    }

    showToast(response.fallback ? 'Sent (via URL)' : 'Sent to Figma', 'success');
    debug('sent');
    debug('Shift+click send success', { id: response.id || '', warning: response.warning || '' });
  } catch (error) {
    showToast('Failed to send image', 'error');
    debug('failed');
    debug('Shift+click send error', error.message || 'Send failed');
  }
}

function findCaptureTarget(event) {
  const target = event.target instanceof Element ? event.target : null;
  const pointElements = getElementsAtPoint(event.clientX, event.clientY);
  const candidates = [];

  for (const element of pointElements) {
    if (element instanceof HTMLImageElement) {
      candidates.push(createImageCaptureCandidate(element, 'image under cursor'));
    }
  }

  const targetImage = target && target.closest ? target.closest('img') : null;
  if (targetImage instanceof HTMLImageElement) {
    candidates.push(createImageCaptureCandidate(targetImage, 'closest img'));
  }

  const picture = target && target.closest ? target.closest('picture') : null;
  if (picture) {
    const pictureImage = picture.querySelector('img');

    if (pictureImage) {
      candidates.push(createImageCaptureCandidate(pictureImage, 'picture img'));
    } else {
      candidates.push(createSrcsetCaptureCandidate(getPictureSourceCandidates(picture), 'picture source'));
    }
  }

  for (const element of [target, ...pointElements]) {
    const backgroundCandidate = getBackgroundCaptureCandidate(element);

    if (backgroundCandidate) {
      candidates.push(backgroundCandidate);
    }
  }

  return candidates.find((candidate) => candidate && candidate.imageUrl) || null;
}

function createImageCaptureCandidate(image, reason) {
  return {
    imageUrl: getBestImageUrl(image),
    reason
  };
}

function createSrcsetCaptureCandidate(candidates, reason) {
  return {
    imageUrl: chooseBestUrl(candidates),
    reason
  };
}

function getBackgroundCaptureCandidate(startElement) {
  if (!(startElement instanceof Element)) {
    return null;
  }

  let element = startElement;
  let depth = 0;

  while (element && element !== document.documentElement && depth < MAX_BACKGROUND_PARENT_DEPTH) {
    const urls = parseCssBackgroundUrls(window.getComputedStyle(element).backgroundImage);
    const imageUrl = chooseBestUrl(urls.map((url) => ({ url, width: 0 })));

    if (imageUrl) {
      return {
        imageUrl,
        reason: depth === 0 ? 'target background-image' : 'parent background-image'
      };
    }

    element = element.parentElement;
    depth += 1;
  }

  return null;
}

function getElementsAtPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return [];
  }

  return document.elementsFromPoint(x, y).filter((element) => element instanceof Element);
}

function handleViewportChange() {
  schedulePositionUpdate();
  scheduleHoverUpdate();
  scheduleScan('viewport-change');
}

function handlePointerMove(event) {
  pointerX = event.clientX;
  pointerY = event.clientY;
  scheduleHoverUpdate();
}

function scheduleScan(reason) {
  if (!pinterestOverlayEnabled) {
    return;
  }

  const elapsed = Date.now() - lastScanAt;
  const delay = Math.max(SCAN_THROTTLE_MS - elapsed, 0);

  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => scan(reason), delay);
}

function scan(reason) {
  lastScanAt = Date.now();
  ensureOverlayRoot();

  const images = Array.from(document.images);
  const skipCounts = new Map();
  const skipSamples = new Set();
  let added = 0;
  let visibleCandidates = 0;

  debug(`Pinterest scan started: ${reason}; images found=${images.length}`);
  removeStaleButtons();

  for (const image of images) {
    const skipReason = getSkipReason(image);

    if (skipReason) {
      if (trackedImages.has(image)) {
        removeButton(image, trackedImages.get(image), skipReason);
      }
      recordSkip(skipReason, image, skipCounts, skipSamples);
      continue;
    }

    visibleCandidates += 1;

    if (trackedImages.has(image)) {
      updateButtonPosition(image, trackedImages.get(image));
      continue;
    }

    if (trackedImages.size >= MAX_VISIBLE_BUTTONS) {
      recordSkip('visible button limit reached', image, skipCounts, skipSamples);
      continue;
    }

    addButtonForImage(image);
    added += 1;
  }

  if (skipCounts.size > 0) {
    debug('Pinterest skip summary', Object.fromEntries(skipCounts));
  }

  debug(`Pinterest scan finished: visible candidates=${visibleCandidates}; buttons added=${added}; tracked=${trackedImages.size}`);
}

function recordSkip(reason, image, skipCounts, skipSamples) {
  skipCounts.set(reason, (skipCounts.get(reason) || 0) + 1);

  if (skipSamples.has(reason) || skipSamples.size >= 10) {
    return;
  }

  skipSamples.add(reason);
  debug(`Pinterest skipped image: ${reason}`, describeImage(image));
}

function getSkipReason(image) {
  if (!image || !image.isConnected) {
    return 'image is detached';
  }

  const rect = image.getBoundingClientRect();

  if (!isInViewport(rect)) {
    return 'outside viewport';
  }

  if (rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) {
    return `rendered size too small (${Math.round(rect.width)}x${Math.round(rect.height)})`;
  }

  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    if (image.naturalWidth < MIN_IMAGE_SIZE || image.naturalHeight < MIN_IMAGE_SIZE) {
      return `natural size too small (${image.naturalWidth}x${image.naturalHeight})`;
    }
  }

  const imageUrl = getBestImageUrl(image);

  if (!imageUrl) {
    return 'missing usable image URL';
  }

  if (!isPinimgUrl(imageUrl)) {
    return 'not a pinimg URL';
  }

  return '';
}

function addButtonForImage(image) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.title = 'Send to Figma';
  button.textContent = '+';

  button.addEventListener('click', (event) => {
    handleOverlayButtonClick(event, image, button);
  });

  overlayRoot.appendChild(button);
  trackedImages.set(image, button);
  updateButtonPosition(image, button);
  hideButton(button);
  debug('Pinterest button added', describeImage(image));
}

async function handleOverlayButtonClick(event, image, button) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const url = getBestImageUrl(image);

  if (!url) {
    setButtonState(button, 'error');
    showToast('No image found', 'error');
    debug('Pinterest send error: no image URL', describeImage(image));
    return;
  }

  setButtonState(button, 'sending');
  debug('sending');
  showToast('Sending to Figma...', 'sending');

  try {
    const response = await sendImageToBackground(url);

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Send failed');
    }

    setButtonState(button, response.warning ? 'sent-warning' : 'sent');
    showToast(response.fallback ? 'Sent (via URL)' : 'Sent to Figma', 'success');
    debug('sent');
    debug('Pinterest send success', { id: response.id || '', warning: response.warning || '', url });
  } catch (error) {
    setButtonState(button, 'error');
    showToast('Failed to send image', 'error');
    debug('failed');
    debug('Pinterest send error', { message: error.message || 'Send failed', url });
  } finally {
    window.setTimeout(() => {
      if (button.isConnected) {
        setButtonState(button, '');
        if (findTrackedImageAtPoint(pointerX, pointerY) === image) {
          setHoveredImage(image);
        } else {
          hideButton(button);
        }
      }
    }, 1600);
  }
}

function sendImageToBackground(imageUrl) {
  return chrome.runtime.sendMessage({
    type: 'CAPTURE_IMAGE',
    imageUrl,
    pageUrl: window.location.href,
    title: document.title
  });
}

function setButtonState(button, state) {
  button.dataset.state = state;
  button.disabled = state === 'sending';

  if (state) {
    showButton(button);
  }
}

function schedulePositionUpdate() {
  if (positionFrame) {
    return;
  }

  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = 0;
    updateTrackedButtonPositions();
  });
}

function updateTrackedButtonPositions() {
  for (const [image, button] of trackedImages.entries()) {
    const skipReason = getSkipReason(image);

    if (skipReason) {
      removeButton(image, button, skipReason);
      continue;
    }

    updateButtonPosition(image, button);
  }
}

function updateButtonPosition(image, button) {
  const rect = image.getBoundingClientRect();
  const size = 36;
  const margin = 10;
  const left = Math.max(0, Math.min(window.innerWidth - size, rect.left + margin));
  const top = Math.max(0, Math.min(window.innerHeight - size, rect.top + margin));

  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(top)}px`;
}

function scheduleHoverUpdate() {
  if (hoverFrame) {
    return;
  }

  hoverFrame = window.requestAnimationFrame(() => {
    hoverFrame = 0;
    updateHoverTarget();
  });
}

function updateHoverTarget() {
  const image = findTrackedImageAtPoint(pointerX, pointerY);

  if (image && !getSkipReason(image)) {
    setHoveredImage(image);
    return;
  }

  clearHoveredImage();
}

function findTrackedImageAtPoint(x, y) {
  const elements = document.elementsFromPoint(x, y);

  for (const element of elements) {
    if (element instanceof HTMLImageElement && trackedImages.has(element)) {
      return element;
    }
  }

  for (const image of trackedImages.keys()) {
    const rect = image.getBoundingClientRect();

    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return image;
    }
  }

  return null;
}

function setHoveredImage(image) {
  if (hoveredImage && hoveredImage !== image) {
    const previousButton = trackedImages.get(hoveredImage);

    if (previousButton && !previousButton.dataset.state) {
      hideButton(previousButton);
    }
  }

  hoveredImage = image;

  const button = trackedImages.get(image);
  if (button) {
    updateButtonPosition(image, button);
    showButton(button);
  }
}

function clearHoveredImage() {
  if (!hoveredImage) {
    return;
  }

  const button = trackedImages.get(hoveredImage);

  if (button && !button.dataset.state) {
    hideButton(button);
  }

  hoveredImage = null;
}

function showButton(button) {
  button.dataset.visible = 'true';
}

function hideButton(button) {
  button.dataset.visible = 'false';
}

function removeStaleButtons() {
  for (const [image, button] of trackedImages.entries()) {
    if (!image.isConnected) {
      removeButton(image, button, 'image detached');
    }
  }
}

function removeButton(image, button, reason) {
  trackedImages.delete(image);

  if (hoveredImage === image) {
    hoveredImage = null;
  }

  button.remove();
  debug(`Pinterest button removed: ${reason}`, describeImage(image));
}

function ensureOverlayRoot() {
  const existingRoot = document.getElementById(OVERLAY_ROOT_ID);

  if (existingRoot) {
    overlayRoot = existingRoot;
    return overlayRoot;
  }

  overlayRoot = document.createElement('div');
  overlayRoot.id = OVERLAY_ROOT_ID;
  document.documentElement.appendChild(overlayRoot);
  return overlayRoot;
}

function showToast(message, state) {
  const node = ensureToastNode();

  window.clearTimeout(toastTimer);
  node.textContent = message;
  node.dataset.state = state;
  node.style.background = getToastBackground(state);
  node.style.opacity = '1';
  node.style.transform = 'translateY(0)';

  toastTimer = window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
  }, state === 'sending' ? 3000 : 2400);
}

function ensureToastNode() {
  const existingNode = document.getElementById(TOAST_ID);

  if (existingNode) {
    toastNode = existingNode;
    return toastNode;
  }

  toastNode = document.createElement('div');
  toastNode.id = TOAST_ID;
  toastNode.setAttribute('role', 'status');
  toastNode.style.position = 'fixed';
  toastNode.style.top = '16px';
  toastNode.style.right = '16px';
  toastNode.style.zIndex = '2147483647';
  toastNode.style.pointerEvents = 'none';
  toastNode.style.borderRadius = '8px';
  toastNode.style.color = '#fff';
  toastNode.style.font = '600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  toastNode.style.minWidth = '150px';
  toastNode.style.maxWidth = '320px';
  toastNode.style.opacity = '0';
  toastNode.style.padding = '10px 12px';
  toastNode.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.28)';
  toastNode.style.textAlign = 'left';
  toastNode.style.transform = 'translateY(-6px)';
  toastNode.style.transition = 'opacity 160ms ease, transform 160ms ease, background 160ms ease';
  document.documentElement.appendChild(toastNode);

  return toastNode;
}

function getToastBackground(state) {
  if (state === 'success') {
    return '#148a42';
  }

  if (state === 'error') {
    return '#b00020';
  }

  return '#24272d';
}

function isInViewport(rect) {
  return rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;
}

function getBestImageUrl(image) {
  const candidates = [];

  if (image.currentSrc) {
    candidates.push({ url: image.currentSrc, width: image.naturalWidth || 0 });
  }

  if (image.src) {
    candidates.push({ url: image.src, width: image.naturalWidth || 0 });
  }

  if (image.srcset) {
    candidates.push(...parseSrcSet(image.srcset));
  }

  const picture = image.closest('picture');
  if (picture) {
    candidates.push(...getPictureSourceCandidates(picture));
  }

  return chooseBestUrl(candidates);
}

function getPictureSourceCandidates(picture) {
  const candidates = [];

  for (const source of Array.from(picture.querySelectorAll('source[srcset]'))) {
    candidates.push(...parseSrcSet(source.srcset));
  }

  return candidates;
}

function parseSrcSet(srcset) {
  return srcset
    .split(',')
    .map((part) => {
      const [rawUrl, descriptor] = part.trim().split(/\s+/);
      const width = parseDescriptorWidth(descriptor);
      const url = normalizeUrl(rawUrl);
      return { url, width };
    })
    .filter((candidate) => candidate.url);
}

function parseDescriptorWidth(descriptor) {
  if (!descriptor) {
    return 0;
  }

  if (descriptor.endsWith('w')) {
    const width = Number.parseInt(descriptor, 10);
    return Number.isFinite(width) ? width : 0;
  }

  if (descriptor.endsWith('x')) {
    const density = Number.parseFloat(descriptor);
    return Number.isFinite(density) ? density * 1000 : 0;
  }

  return 0;
}

function parseCssBackgroundUrls(backgroundImage) {
  if (!backgroundImage || backgroundImage === 'none') {
    return [];
  }

  const urls = [];
  const pattern = /url\((['"]?)(.*?)\1\)/g;
  let match = pattern.exec(backgroundImage);

  while (match) {
    const url = normalizeUrl(match[2]);

    if (url) {
      urls.push(url);
    }

    match = pattern.exec(backgroundImage);
  }

  return urls;
}

function chooseBestUrl(candidates) {
  const best = candidates
    .map((candidate) => ({
      url: normalizeUrl(candidate.url),
      width: Number.isFinite(candidate.width) ? candidate.width : 0
    }))
    .filter((candidate) => isSupportedImageUrl(candidate.url))
    .sort((a, b) => b.width - a.width)[0];

  return best ? best.url : '';
}

function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return '';
  }

  const trimmed = url.trim();

  if (/^data:image\//i.test(trimmed)) {
    return trimmed;
  }

  try {
    return new URL(trimmed, document.baseURI).href;
  } catch (error) {
    return '';
  }
}

function isSupportedImageUrl(url) {
  return /^https?:\/\//i.test(url) || /^data:image\//i.test(url);
}

function isPinimgUrl(url) {
  try {
    return new URL(url).hostname.endsWith('pinimg.com');
  } catch (error) {
    return false;
  }
}

function isPinterestPage() {
  return /(^|\.)pinterest\./i.test(window.location.hostname);
}

function describeImage(image) {
  const rect = image && image.getBoundingClientRect ? image.getBoundingClientRect() : { width: 0, height: 0 };

  return {
    src: image ? getBestImageUrl(image) : '',
    rendered: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    natural: image ? `${image.naturalWidth || 0}x${image.naturalHeight || 0}` : '0x0'
  };
}

function debug(message, details) {
  if (details === undefined) {
    console.debug(LOG_PREFIX, message);
    return;
  }

  console.debug(LOG_PREFIX, message, details);
}
