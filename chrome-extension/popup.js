// Lưu trữ dữ liệu đã extract
let extractedData = null;

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const saved = await chrome.storage.local.get(['userId', 'serverUrl', 'fromDate', 'toDate']);

  if (saved.userId) document.getElementById('userId').value = saved.userId;
  if (saved.serverUrl) document.getElementById('serverUrl').value = saved.serverUrl;

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  document.getElementById('fromDate').value = saved.fromDate || firstDay;
  document.getElementById('toDate').value = saved.toDate || today;
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

// Show result
function showResult(data) {
  const result = document.getElementById('result');
  const resultData = document.getElementById('resultData');
  resultData.textContent = JSON.stringify(data, null, 2);
  result.className = 'result show';
}

// Extract button click
document.getElementById('extractBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractBtn');
  btn.disabled = true;
  btn.textContent = 'Đang lấy...';
  showStatus('Đang extract dữ liệu từ trang...', 'info');

  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes('partner.shopee.vn')) {
      showStatus('Vui lòng mở trang partner.shopee.vn trước!', 'error');
      btn.disabled = false;
      btn.textContent = 'Lấy dữ liệu';
      return;
    }

    // Send message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractData',
      fromDate: document.getElementById('fromDate').value,
      toDate: document.getElementById('toDate').value
    });

    if (response && response.success) {
      extractedData = {
        userId: document.getElementById('userId').value,
        orders: response.orders,
        total: response.orders.length,
        storeName: response.storeName,
        dateRange: {
          from: document.getElementById('fromDate').value,
          to: document.getElementById('toDate').value
        },
        extractedAt: new Date().toISOString()
      };

      showStatus(`Lấy được ${response.orders.length} đơn hàng!`, 'success');
      showResult(extractedData);
    } else {
      showStatus(response?.error || 'Không thể extract dữ liệu', 'error');
    }
  } catch (error) {
    showStatus(`Lỗi: ${error.message}. Hãy refresh trang và thử lại.`, 'error');
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

  try {
    const serverUrl = document.getElementById('serverUrl').value;
    const response = await fetch(`${serverUrl}/api/extension/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(extractedData)
    });

    const result = await response.json();

    if (result.success) {
      showStatus('Đã gửi dữ liệu thành công!', 'success');
    } else {
      showStatus(`Lỗi: ${result.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Không thể kết nối server: ${error.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Gửi lên Server';
});
