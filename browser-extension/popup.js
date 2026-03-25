document.getElementById('connectBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    if (resp.connected) {
      updateStatus(true);
    } else {
      updateStatus(false);
    }
  });
});

function updateStatus(connected) {
  const status = document.getElementById('status');
  status.className = connected ? 'connected' : 'disconnected';
  status.textContent = connected ? 'Connected ✓' : 'Disconnected ✗';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    updateStatus(msg.connected);
  }
});

chrome.runtime.sendMessage({ type: 'getStatus' }, updateStatus);
