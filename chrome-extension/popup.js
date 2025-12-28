// Lưu trữ dữ liệu đã extract
let extractedData = null;
let autoSyncInterval = null;
let syncCount = 0;

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const saved = await chrome.storage.local.get(['userId', 'serverUrl', 'fromDate', 'toDate', 'autoSync']);

  if (saved.userId) document.getElementById('userId').value = saved.userId;
  if (saved.serverUrl) document.getElementById('serverUrl').value = saved.serverUrl;

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  document.getElementById('fromDate').value = saved.fromDate || firstDay;
  document.getElementById('toDate').value = saved.toDate || today;

  // Restore auto-sync state
  if (saved.autoSync) {
    document.getElementById('autoSync').checked = true;
    startAutoSync();
  }
});

// Save settings on change
['userId', 'serverUrl', 'fromDate', 'toDate'].forEach(id => {
  document.getElementById(id).addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [id]: e.target.value });
  });
});

// Show status message
function showStatus(message, type = 'info') {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status show ${type}`;
}

// Show sync status
function showSyncStatus(message) {
  const syncStatus = document.getElementById('syncStatus');
  syncStatus.textContent = message;
  syncStatus.style.display = 'block';
}

// Show result
function showResult(data) {
  const result = document.getElementById('result');
  const resultData = document.getElementById('resultData');
  resultData.textContent = JSON.stringify(data, null, 2);
  result.className = 'result show';
}

// Extract data function (reusable)
async function extractData() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes('partner.shopee.vn')) {
      return { success: false, error: 'Không phải trang Shopee Partner' };
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractData',
      fromDate: document.getElementById('fromDate').value,
      toDate: document.getElementById('toDate').value
    });

    if (response && response.success) {
      return {
        success: true,
        data: {
          userId: document.getElementById('userId').value,
          orders: response.orders,
          total: response.orders.length,
          storeName: response.storeName,
          dateRange: {
            from: document.getElementById('fromDate').value,
            to: document.getElementById('toDate').value
          },
          extractedAt: new Date().toISOString()
        }
      };
    }
    return { success: false, error: response?.error || 'Không thể extract' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send data to server function (reusable)
async function sendToServer(data) {
  try {
    const serverUrl = document.getElementById('serverUrl').value;
    const response = await fetch(`${serverUrl}/api/extension/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Auto sync function
async function doAutoSync() {
  syncCount++;
  const now = new Date().toLocaleTimeString('vi-VN');
  showSyncStatus(`[${now}] Đang sync lần ${syncCount}...`);

  // Extract
  const extractResult = await extractData();
  if (!extractResult.success) {
    showSyncStatus(`[${now}] Lỗi extract: ${extractResult.error}`);
    return;
  }

  extractedData = extractResult.data;
  showResult(extractedData);

  // Send
  const sendResult = await sendToServer(extractedData);
  if (sendResult.success) {
    showSyncStatus(`[${now}] Sync OK - ${extractedData.orders.length} đơn`);
    showStatus(`Auto sync: ${extractedData.orders.length} đơn hàng`, 'success');
  } else {
    showSyncStatus(`[${now}] Lỗi gửi: ${sendResult.error}`);
  }
}

// Start auto sync
function startAutoSync() {
  if (autoSyncInterval) return;

  syncCount = 0;
  showSyncStatus('Auto sync đang chạy...');

  // Run immediately first
  doAutoSync();

  // Then every 5 seconds
  autoSyncInterval = setInterval(doAutoSync, 5000);
}

// Stop auto sync
function stopAutoSync() {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
  }
  document.getElementById('syncStatus').style.display = 'none';
  showStatus('Auto sync đã tắt', 'info');
}

// Auto sync toggle
document.getElementById('autoSync').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ autoSync: enabled });

  if (enabled) {
    startAutoSync();
  } else {
    stopAutoSync();
  }
});

// Extract button click
document.getElementById('extractBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractBtn');
  btn.disabled = true;
  btn.textContent = 'Đang lấy...';
  showStatus('Đang extract dữ liệu từ trang...', 'info');

  const result = await extractData();

  if (result.success) {
    extractedData = result.data;
    showStatus(`Lấy được ${extractedData.orders.length} đơn hàng!`, 'success');
    showResult(extractedData);
  } else {
    showStatus(`Lỗi: ${result.error}. Hãy refresh trang và thử lại.`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Lấy dữ liệu';
});

// Send to server button click
document.getElementById('sendBtn').addEventListener('click', async () => {
  if (!extractedData) {
    showStatus('Chưa có dữ liệu! Hãy lấy dữ liệu trước.', 'error');
    return;
  }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'Đang gửi...';
  showStatus('Đang gửi dữ liệu lên server...', 'info');

  const result = await sendToServer(extractedData);

  if (result.success) {
    showStatus('Đã gửi dữ liệu thành công!', 'success');
  } else {
    showStatus(`Lỗi: ${result.error}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Gửi lên Server';
});
