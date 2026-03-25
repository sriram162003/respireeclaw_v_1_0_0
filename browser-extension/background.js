const WS_URL = 'ws://localhost:3002/webextension';

let ws = null;
let connected = false;
let reconnectTimer = null;

// ── Keep the service worker alive ─────────────────────────────────────────────
// Chrome MV3 kills service workers after ~30s of inactivity.
// We use chrome.alarms (fires every 25s) to wake it back up and ensure
// the WebSocket stays connected.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every ~24s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!connected) connect();
  }
});

// ── WebSocket connection ───────────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.error('[Gary] Failed to create WebSocket:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log('[Gary] Connected to gateway at', WS_URL);
    broadcastStatus(true);
  };

  ws.onclose = (ev) => {
    connected = false;
    console.log('[Gary] Disconnected (code=' + ev.code + ') — retrying in 3s');
    broadcastStatus(false);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[Gary] WebSocket error:', err);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    console.log('[Gary] Command:', msg.command ?? msg.type, '| id:', msg.id);

    // Keepalive ping from gateway
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ id: msg.id, result: 'pong' }));
      return;
    }

    // Screenshot — must run in background, not content script
    if (msg.command === 'screenshot') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { ws.send(JSON.stringify({ id: msg.id, error: 'No active tab' })); return; }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        ws.send(JSON.stringify({ id: msg.id, result: { dataUrl, tabUrl: tab.url, tabTitle: tab.title } }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, error: e.message }));
      }
      return;
    }

    // All other commands delegated to content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { ws.send(JSON.stringify({ id: msg.id, error: 'No active tab' })); return; }

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (m) => window.garyHandler && window.garyHandler(m),
        args: [msg]
      });
      ws.send(JSON.stringify({ id: msg.id, result: result[0]?.result ?? null }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, error: e.message }));
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

function broadcastStatus(isConnected) {
  chrome.runtime.sendMessage({ type: 'status', connected: isConnected }).catch(() => {});
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'getStatus') sendResponse({ connected });
  return true;
});

// Connect on startup
connect();
