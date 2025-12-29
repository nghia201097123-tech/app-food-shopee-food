// Lưu trữ dữ liệu đã fetch
let fetchedData = null;
let autoSyncInterval = null;
let syncCount = 0;

// API URLs
const API_STORE_LIST = 'https://app.partner.shopee.vn/mss/app-api/PartnerRNServer/GetStoreList';
const API_ORDER_LIST = 'https://gmerchant.deliverynow.vn/api/v5/order/get_list';

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const saved = await chrome.storage.local.get(['userId', 'serverUrl', 'accessToken', 'entityId', 'userAgent', 'autoSync']);

  if (saved.userId) document.getElementById('userId').value = saved.userId;
  if (saved.serverUrl) document.getElementById('serverUrl').value = saved.serverUrl;
  if (saved.accessToken) document.getElementById('accessToken').value = saved.accessToken;
  if (saved.entityId) document.getElementById('entityId').value = saved.entityId;
  if (saved.userAgent) document.getElementById('userAgent').value = saved.userAgent;

  // Restore auto-sync state
  if (saved.autoSync) {
    document.getElementById('autoSync').checked = true;
    startAutoSync();
  }
});

// Save settings on change
['userId', 'serverUrl', 'accessToken', 'entityId', 'userAgent'].forEach(id => {
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

// Get Store List API
async function fetchStoreList() {
  const accessToken = document.getElementById('accessToken').value.trim();

  if (!accessToken) {
    return { success: false, error: 'Chưa nhập Access Token' };
  }

  try {
    const response = await fetch(API_STORE_LIST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'x-merchant-token': accessToken
      },
      body: JSON.stringify({})
    });

    const data = await response.json();
    return {
      success: response.ok,
      statusCode: response.status,
      apiType: 'store_list',
      data: data
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get Order List API
async function fetchOrderList() {
  const accessToken = document.getElementById('accessToken').value.trim();
  const entityId = document.getElementById('entityId').value.trim();
  const userAgent = document.getElementById('userAgent').value.trim() || 'language=vi app_type=29';

  if (!accessToken) {
    return { success: false, error: 'Chưa nhập Access Token' };
  }
  if (!entityId) {
    return { success: false, error: 'Chưa nhập Entity ID (ID cửa hàng)' };
  }

  try {
    const response = await fetch(API_ORDER_LIST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'vi-VN,vi,fr-FR,fr,en-US,en',
        'user-agent': userAgent,
        'x-foody-client-id': 'CD1C90F850C14104827124E1AC7F263A',
        'x-foody-access-token': accessToken,
        'x-foody-entity-id': entityId,
        'x-foody-client-language': 'vi',
        'x-foody-api-version': '1',
        'x-foody-app-type': '1024',
        'x-foody-client-type': '1',
        'x-foody-client-version': '3.0.0',
        'operate-source': 'partnerapp'
      },
      body: JSON.stringify({
        order_filter_type: 31,
        next_item_id: '',
        request_count: 50,
        sort_type: 5
      })
    });

    const data = await response.json();
    return {
      success: response.ok && !data.error,
      statusCode: response.status,
      apiType: 'order_list',
      data: data
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send data to server
async function sendToServer(data, apiType) {
  try {
    const serverUrl = document.getElementById('serverUrl').value;
    const userId = document.getElementById('userId').value;
    const entityId = document.getElementById('entityId').value;

    const payload = {
      userId: userId,
      entityId: entityId,
      source: 'shopee-api',
      apiType: apiType,
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

// Auto sync function (fetch orders)
async function doAutoSync() {
  syncCount++;
  const now = new Date().toLocaleTimeString('vi-VN');
  showSyncStatus(`[${now}] Đang lấy orders lần ${syncCount}...`);

  // Fetch orders
  const apiResult = await fetchOrderList();

  if (!apiResult.success) {
    showSyncStatus(`[${now}] Lỗi: ${apiResult.error || apiResult.data?.error || 'Unknown'}`);
    showStatus(`Lỗi: ${apiResult.error || JSON.stringify(apiResult.data)}`, 'error');
    return;
  }

  fetchedData = apiResult;
  showResult(fetchedData.data);

  // Send to server
  const sendResult = await sendToServer(fetchedData.data, 'order_list');

  if (sendResult.success) {
    const orderCount = fetchedData.data?.data?.length || 0;
    showSyncStatus(`[${now}] Sync OK - ${orderCount} orders`);
    showStatus(`Auto sync: ${orderCount} đơn hàng`, 'success');
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

// Fetch Store List button
document.getElementById('fetchStoresBtn').addEventListener('click', async () => {
  const btn = document.getElementById('fetchStoresBtn');
  btn.disabled = true;
  btn.textContent = 'Đang lấy...';
  showStatus('Đang gọi API Store List...', 'info');

  const result = await fetchStoreList();

  if (result.success) {
    fetchedData = result;
    const storeCount = result.data?.data?.length || 0;
    showStatus(`Thành công! Lấy được ${storeCount} stores`, 'success');
    showResult(result.data);
  } else {
    showStatus(`Lỗi: ${result.error || JSON.stringify(result.data)}`, 'error');
    if (result.data) showResult(result.data);
  }

  btn.disabled = false;
  btn.textContent = 'Lấy Store List';
});

// Fetch Orders button
document.getElementById('fetchOrdersBtn').addEventListener('click', async () => {
  const btn = document.getElementById('fetchOrdersBtn');
  btn.disabled = true;
  btn.textContent = 'Đang lấy...';
  showStatus('Đang gọi API Order List...', 'info');

  const result = await fetchOrderList();

  if (result.success) {
    fetchedData = result;
    const orderCount = result.data?.data?.length || 0;
    showStatus(`Thành công! Lấy được ${orderCount} đơn hàng`, 'success');
    showResult(result.data);
  } else {
    showStatus(`Lỗi: ${result.error || JSON.stringify(result.data)}`, 'error');
    if (result.data) showResult(result.data);
  }

  btn.disabled = false;
  btn.textContent = 'Lấy Orders';
});

// Send to server button
document.getElementById('sendBtn').addEventListener('click', async () => {
  if (!fetchedData) {
    showStatus('Chưa có dữ liệu! Hãy lấy data trước.', 'error');
    return;
  }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'Đang gửi...';
  showStatus('Đang gửi dữ liệu lên server...', 'info');

  const result = await sendToServer(fetchedData.data, fetchedData.apiType);

  if (result.success) {
    showStatus('Đã gửi dữ liệu thành công!', 'success');
  } else {
    showStatus(`Lỗi: ${result.error}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Gửi lên Server';
});
