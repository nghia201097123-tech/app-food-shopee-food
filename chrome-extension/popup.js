// Lưu trữ dữ liệu đã fetch
let fetchedData = null;
let autoSyncInterval = null;
let syncCount = 0;

// Shopee API URL
const SHOPEE_API_URL = 'https://app.partner.shopee.vn/mss/app-api/PartnerRNServer/GetStoreList';

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const saved = await chrome.storage.local.get(['userId', 'serverUrl', 'merchantToken', 'autoSync']);

  if (saved.userId) document.getElementById('userId').value = saved.userId;
  if (saved.serverUrl) document.getElementById('serverUrl').value = saved.serverUrl;
  if (saved.merchantToken) document.getElementById('merchantToken').value = saved.merchantToken;

  // Restore auto-sync state
  if (saved.autoSync) {
    document.getElementById('autoSync').checked = true;
    startAutoSync();
  }
});

// Save settings on change
['userId', 'serverUrl', 'merchantToken'].forEach(id => {
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

// Call Shopee API directly
async function callShopeeApi() {
  const merchantToken = document.getElementById('merchantToken').value.trim();

  if (!merchantToken) {
    return { success: false, error: 'Chưa nhập Merchant Token' };
  }

  try {
    const response = await fetch(SHOPEE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'x-merchant-token': merchantToken
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    return {
      success: response.ok,
      statusCode: response.status,
      data: data
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send data to server
async function sendToServer(data) {
  try {
    const serverUrl = document.getElementById('serverUrl').value;
    const userId = document.getElementById('userId').value;

    const payload = {
      userId: userId,
      source: 'shopee-api',
      apiEndpoint: SHOPEE_API_URL,
      data: data,
      fetchedAt: new Date().toISOString()
    };

    const response = await fetch(`${serverUrl}/api/extension/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
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
  showSyncStatus(`[${now}] Đang gọi API lần ${syncCount}...`);

  // Call Shopee API
  const apiResult = await callShopeeApi();

  if (!apiResult.success) {
    showSyncStatus(`[${now}] Lỗi API: ${apiResult.error || 'Unknown'}`);
    showStatus(`Lỗi: ${apiResult.error || JSON.stringify(apiResult.data)}`, 'error');
    return;
  }

  fetchedData = apiResult.data;
  showResult(fetchedData);

  // Send to server
  const sendResult = await sendToServer(fetchedData);

  if (sendResult.success) {
    const storeCount = fetchedData?.data?.length || 0;
    showSyncStatus(`[${now}] Sync OK - ${storeCount} stores`);
    showStatus(`Auto sync: ${storeCount} stores`, 'success');
  } else {
    showSyncStatus(`[${now}] Lỗi gửi server: ${sendResult.error}`);
  }
}

// Start auto sync (10 seconds)
function startAutoSync() {
  if (autoSyncInterval) return;

  syncCount = 0;
  showSyncStatus('Auto sync đang chạy (10s)...');

  // Run immediately first
  doAutoSync();

  // Then every 10 seconds
  autoSyncInterval = setInterval(doAutoSync, 10000);
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

// Fetch API button click
document.getElementById('fetchApiBtn').addEventListener('click', async () => {
  const btn = document.getElementById('fetchApiBtn');
  btn.disabled = true;
  btn.textContent = 'Đang gọi API...';
  showStatus('Đang gọi Shopee API...', 'info');

  const result = await callShopeeApi();

  if (result.success) {
    fetchedData = result.data;
    const storeCount = result.data?.data?.length || 0;
    showStatus(`Thành công! Lấy được ${storeCount} stores`, 'success');
    showResult(fetchedData);
  } else {
    showStatus(`Lỗi: ${result.error || JSON.stringify(result.data)}`, 'error');
    if (result.data) {
      showResult(result.data);
    }
  }

  btn.disabled = false;
  btn.textContent = 'Gọi API lấy Store List';
});

// Send to server button click
document.getElementById('sendBtn').addEventListener('click', async () => {
  if (!fetchedData) {
    showStatus('Chưa có dữ liệu! Hãy gọi API trước.', 'error');
    return;
  }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'Đang gửi...';
  showStatus('Đang gửi dữ liệu lên server...', 'info');

  const result = await sendToServer(fetchedData);

  if (result.success) {
    showStatus('Đã gửi dữ liệu thành công!', 'success');
  } else {
    showStatus(`Lỗi: ${result.error}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Gửi lên Server';
});
