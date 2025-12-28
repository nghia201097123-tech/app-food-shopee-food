// Content script - chạy trên trang partner.shopee.vn

// Lắng nghe message từ popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractData') {
    extractOrderData()
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Giữ channel mở cho async response
  }
});

// Extract dữ liệu đơn hàng từ bảng
async function extractOrderData() {
  try {
    // Lấy tên cửa hàng
    const storeNameEl = document.querySelector('[class*="store-name"], [class*="shop-name"], .user-info, header [class*="name"]');
    const storeName = storeNameEl?.textContent?.trim() || 'Unknown Store';

    // Tìm bảng dữ liệu
    const orders = [];

    // Thử nhiều selector khác nhau
    let rows = document.querySelectorAll('table tbody tr');

    if (rows.length === 0) {
      rows = document.querySelectorAll('table tr');
    }

    if (rows.length === 0) {
      rows = document.querySelectorAll('[class*="ant-table"] tr, [class*="table-row"]');
    }

    console.log(`[Shopee Extractor] Found ${rows.length} rows`);

    rows.forEach((row, index) => {
      const cells = row.querySelectorAll('td');

      // Bỏ qua header row
      if (cells.length === 0) return;

      // Cần ít nhất 6 cột
      if (cells.length >= 6) {
        const order = {
          stt: cells[0]?.textContent?.trim(),
          nhaHang: cells[1]?.textContent?.trim(),
          soLuongDon: cells[2]?.textContent?.trim(),
          tongTienTruocChietKhau: cells[3]?.textContent?.trim(),
          khuyenMai: cells[4]?.textContent?.trim(),
          phiDichVu: cells[5]?.textContent?.trim(),
          thueKhauTru: cells[6]?.textContent?.trim() || '',
          tongTien: cells[7]?.textContent?.trim() || ''
        };

        // Kiểm tra có phải header không
        if (order.stt && order.stt !== 'Stt' && order.stt !== 'STT') {
          orders.push(order);
        }
      }
    });

    console.log(`[Shopee Extractor] Extracted ${orders.length} orders`);

    // Nếu không tìm thấy đơn hàng, thử cách khác
    if (orders.length === 0) {
      // Có thể trang chưa load xong hoặc cấu trúc khác
      const pageContent = document.body.innerText;

      if (pageContent.includes('Không tìm thấy')) {
        return {
          success: false,
          error: 'Trang hiển thị "Không tìm thấy". Vui lòng vào đúng trang Doanh thu.'
        };
      }

      if (!pageContent.includes('Doanh số') && !pageContent.includes('Doanh thu')) {
        return {
          success: false,
          error: 'Vui lòng vào trang "Quản lý đơn hàng" > "Doanh thu" trước khi extract.'
        };
      }
    }

    return {
      success: true,
      orders: orders,
      storeName: storeName,
      url: window.location.href
    };

  } catch (error) {
    console.error('[Shopee Extractor] Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Thêm indicator khi extension active
function addIndicator() {
  if (document.getElementById('shopee-extractor-indicator')) return;

  const indicator = document.createElement('div');
  indicator.id = 'shopee-extractor-indicator';
  indicator.innerHTML = '📊 Shopee Extractor Active';
  indicator.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #ee4d2d;
    color: white;
    padding: 8px 15px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    z-index: 99999;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  `;
  document.body.appendChild(indicator);

  // Tự ẩn sau 3 giây
  setTimeout(() => {
    indicator.style.opacity = '0.5';
  }, 3000);
}

// Khởi tạo
console.log('[Shopee Extractor] Content script loaded');
addIndicator();
