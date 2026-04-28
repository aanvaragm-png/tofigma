# Pinterest to Figma References

Cloud-ready MVP for sending reference images from any website into Figma.

Default hosted backend:

```text
https://pinterest-to-figma.onrender.com
```

Flow:

```text
Any website -> Chrome extension -> cloud backend -> Figma plugin -> Figma canvas
```

The Chrome extension never writes to the Figma canvas. It only sends image data to the backend. The Figma plugin polls the backend and inserts images into a `Pinterest References` frame.

## Project Structure

```text
backend/       Node.js/Express queue API
extension/     Manifest V3 Chrome extension for image capture
figma-plugin/  Figma plugin UI and canvas importer
```

## Backend

Install dependencies and run locally:

```bash
cd backend
npm install
npm start
```

The backend listens on `PORT` or `4177` by default.

Health check:

```bash
curl http://localhost:4177/health
```

API:

- `GET /health`
- `POST /api/images`
- `GET /api/images?sessionId=...`
- `POST /api/images/:id/ack`

The backend uses an in-memory queue keyed by `sessionId`. For a larger production version, replace the `queues` map in `backend/server.js` with Redis, Postgres, or another persistent store.

## Deploy Backend

Render, Railway, and Fly.io can all run this service as a simple Node app.

Typical settings:

- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Environment:
  - `PORT`: set by the host
  - `CORS_ORIGIN`: optional, defaults to `*`
  - `JSON_LIMIT`: optional, defaults to `15mb`
  - `MAX_ITEMS_PER_SESSION`: optional, defaults to `100`
  - `ITEM_TTL_MS`: optional, defaults to `86400000`

Copy the deployed HTTPS URL. Use that same backend URL in both the Chrome extension and the Figma plugin.

For regular users, the Chrome extension and Figma plugin already default to:

```text
https://pinterest-to-figma.onrender.com
```

Only change the Backend URL if you deploy your own backend.

For Figma Community publication, this backend domain is already declared in `figma-plugin/manifest.json` under `networkAccess.allowedDomains`, so the published plugin can fetch from the hosted backend without users importing or editing the manifest manually.

## Load Chrome Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension` folder.
5. Open the extension popup.
6. Confirm the Backend URL is already filled.
7. Use the generated Session ID or create one.

The extension works on all websites. Hold Shift and click an image to send it to Figma. On Pinterest, the optional red `+` overlay can still be enabled from the extension popup.

After Shift-clicking an image, the page shows a small toast in the top-right corner: sending, success, or error.

## Import Figma Plugin

1. Open Figma desktop.
2. Go to Plugins -> Development -> Import plugin from manifest.
3. Select `figma-plugin/manifest.json`.
4. Run the `Pinterest References` plugin.
5. Confirm the Backend URL is already filled.
6. Paste the same Session ID used in the extension.
7. Click Connect.

The plugin saves settings with `figma.clientStorage`, polls the backend, creates or reuses a `Pinterest References` frame, inserts queued images, and sends `ack` only after a successful insert.

## End-to-End Check

1. Use the default hosted backend or start/deploy your own backend.
2. Install the Chrome extension.
3. Install or run the Figma plugin.
4. Save the same Session ID in the extension and the Figma plugin.
5. In Figma, click Connect or Pull Now.
6. Open any website.
7. Hold Shift and click an image.
8. Confirm the image appears in the `Pinterest References` frame.

On Pinterest, you can also enable `Show Pinterest + buttons` in the extension popup and click the red `+` on large Pinterest images.

## Error Handling

- Backend offline: extension and plugin show a connection/backend error.
- Empty queue: plugin shows `Queue is empty.`
- Image fetch failed: the extension stores the image URL as fallback. Some sites block direct image loading or use protected/blob images; in those cases the plugin may show a fetch error instead of inserting the image.
- Invalid sessionId: backend returns `invalid_session_id`, and both UIs validate the format.
- CORS issues: backend responds to `OPTIONS` and sets `Access-Control-Allow-Origin`. If a browser still blocks a request, the plugin reports a CORS/backend message.

## Chrome Extension Notes

- Manifest V3.
- No remote hosted code.
- Remote network calls are data/API calls only.
- The extension does not touch Figma. Canvas writes are handled only by the Figma plugin.
