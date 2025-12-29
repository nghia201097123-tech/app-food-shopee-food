const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// Sử dụng Stealth Plugin để tránh bị detect
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PROFILES_DIR = "./profiles";
const CUSTOMERS_FILE = "./customers.json";

// ========== QUẢN LÝ KHÁCH HÀNG ==========
// Load customers từ file
function loadCustomers() {
  try {
    if (fs.existsSync(CUSTOMERS_FILE)) {
      const data = fs.readFileSync(CUSTOMERS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.log("Không thể load customers:", e.message);
  }
  return [];
}

// Save customers to file
function saveCustomers(customers) {
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

// Lưu kết quả fetch
const fetchResults = new Map();
const activeSessions = new Map();

// Queue để xử lý tuần tự, tránh quá tải
const requestQueue = [];
let isProcessing = false;
const MAX_CONCURRENT = 3; // Số browser chạy đồng thời tối đa
let currentRunning = 0;

if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ========== HELPER FUNCTIONS ==========

async function createBrowser(userId, headless = true) {
  const userDataDir = path.join(PROFILES_DIR, userId);

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const launchOptions = {
    headless: headless ? "new" : false,
    userDataDir: userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--window-size=1366,768",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: { width: 1366, height: 768 },
    timeout: 60000,
  };

  // Thử dùng Chrome có sẵn trên Mac
  const possiblePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];

  for (const chromePath of possiblePaths) {
    if (fs.existsSync(chromePath)) {
      launchOptions.executablePath = chromePath;
      break;
    }
  }

  const browser = await puppeteer.launch(launchOptions);
  return browser;
}

// Thiết lập page để tránh bị detect
async function setupStealthPage(page) {
  // Ẩn webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake chrome runtime
    window.chrome = { runtime: {} };

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['vi-VN', 'vi', 'en-US', 'en']
    });

    // Fake permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  // Set viewport và user agent thực tế
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
}

async function checkLoginStatus(page) {
  await delay(1000);
  const url = page.url();
  const content = await page.content();

  // Kiểm tra trang đăng nhập
  if (url.includes("login") || url.includes("auth")) {
    const hasLoginForm = await page.$('input[type="password"]');
    if (hasLoginForm) {
      return "NEED_LOGIN";
    }
  }

  // Kiểm tra form đăng nhập trong content
  if (content.includes("Đăng nhập") && !content.includes("Đăng xuất")) {
    const hasLoginForm = await page.$('input[type="password"]');
    if (hasLoginForm) {
      return "NEED_LOGIN";
    }
  }

  // Kiểm tra OTP
  const hasOTP = await page.$('input[placeholder*="OTP"], input[placeholder*="mã xác"], input[type="tel"][maxlength="6"]');
  if (hasOTP) {
    return "NEED_OTP";
  }

  // Kiểm tra trang "Tiếp tục với Shopee"
  if (content.includes("Tiếp tục với Shopee") || content.includes("đang đăng nhập vào tài khoản")) {
    return "NEED_CONTINUE";
  }

  // Kiểm tra trang chọn cửa hàng
  if (content.includes("Chọn đối tác") || content.includes("Danh sách Đối tác")) {
    return "NEED_SELECT_STORE";
  }

  return "LOGGED_IN";
}

async function clickContinueButton(page) {
  // Tìm và click nút "Tiếp tục"
  const buttons = await page.$$("button");
  for (const btn of buttons) {
    const text = await page.evaluate((el) => el.textContent, btn);
    if (text && text.trim() === "Tiếp tục") {
      await btn.click();
      await delay(3000);
      return true;
    }
  }
  return false;
}

async function getStoreList(page) {
  return await page.evaluate(() => {
    const stores = [];
    // Tìm các item trong danh sách đối tác
    const storeItems = document.querySelectorAll('[class*="partner"], [class*="store"], [class*="merchant"]');

    if (storeItems.length === 0) {
      // Fallback: tìm theo text pattern
      document.querySelectorAll("div").forEach((div, index) => {
        const text = div.textContent?.trim();
        if (text && (text.includes("[Mới]") || text.includes("Quán") || text.includes("Cơm") || text.includes("Phở"))) {
          if (text.length > 5 && text.length < 100 && !stores.find(s => s.name === text)) {
            stores.push({ index, name: text });
          }
        }
      });
    } else {
      storeItems.forEach((item, index) => {
        stores.push({ index, name: item.textContent?.trim() });
      });
    }

    return stores.slice(0, 20);
  });
}

async function selectStore(page, storeIndex = 0, storeName = null) {
  // Click vào cửa hàng theo index hoặc tên
  const clicked = await page.evaluate((targetIndex, targetName) => {
    const items = document.querySelectorAll('[class*="partner-item"], [class*="store-item"]');

    if (items.length > 0 && items[targetIndex]) {
      items[targetIndex].click();
      return true;
    }

    // Fallback: click theo tên hoặc pattern
    const divs = document.querySelectorAll("div");
    for (const div of divs) {
      const text = div.textContent?.trim();
      if (targetName && text === targetName) {
        div.click();
        return true;
      }
      if (text && (text.includes("[Mới]") || text.includes("Quán")) && text.length < 100) {
        // Click vào element có thể click được
        const clickable = div.querySelector("a, button") || div;
        clickable.click();
        return true;
      }
    }
    return false;
  }, storeIndex, storeName);

  if (clicked) {
    await delay(3000);
  }
  return clicked;
}

async function setDateRange(page, fromDate, toDate) {
  try {
    // Format: DD/MM/YYYY
    const formatDate = (dateStr) => {
      if (!dateStr) return null;
      // Nếu đã đúng format DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
      // Nếu format YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split("-");
        return `${d}/${m}/${y}`;
      }
      return dateStr;
    };

    const from = formatDate(fromDate);
    const to = formatDate(toDate);

    if (!from || !to) return false;

    // Tìm input ngày "Từ"
    const dateInputs = await page.$$('input[type="text"]');

    for (let i = 0; i < dateInputs.length; i++) {
      const placeholder = await page.evaluate(el => el.placeholder || el.getAttribute('aria-label') || '', dateInputs[i]);
      const value = await page.evaluate(el => el.value, dateInputs[i]);

      // Input "Từ" (from date)
      if (i === 0 || placeholder.includes("Từ") || value.includes("/")) {
        await dateInputs[i].click({ clickCount: 3 });
        await dateInputs[i].type(from, { delay: 30 });
      }
      // Input "Đến" (to date)
      if (i === 1 || placeholder.includes("Đến")) {
        await dateInputs[i].click({ clickCount: 3 });
        await dateInputs[i].type(to, { delay: 30 });
      }
    }

    // Click nút "Tìm kiếm"
    const buttons = await page.$$("button");
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent?.trim(), btn);
      if (text && text.includes("Tìm kiếm")) {
        await btn.click();
        await delay(2000);
        break;
      }
    }

    return true;
  } catch (error) {
    console.log(`   [WARN] Không thể set date range: ${error.message}`);
    return false;
  }
}

// Navigate to Doanh thu page via menu clicks
async function navigateToReportPage(page) {
  try {
    console.log(`   -> Đang vào trang Doanh thu qua menu...`);

    // Lấy URL hiện tại của trang Doanh thu từ menu
    const reportUrl = await page.evaluate(() => {
      // Tìm tất cả link trong sidebar
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const text = link.textContent?.trim();
        const href = link.getAttribute('href');
        // Tìm link "Doanh thu"
        if (text === 'Doanh thu' && href) {
          return link.href; // Trả về full URL
        }
      }
      return null;
    });

    if (reportUrl) {
      console.log(`   -> Tìm thấy URL Doanh thu: ${reportUrl}`);
      // Navigate trực tiếp đến URL thay vì click
      await page.goto(reportUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await delay(3000);

      // Kiểm tra xem có vào đúng trang không
      const pageTitle = await page.evaluate(() => {
        const h1 = document.querySelector('h1, h2, [class*="title"]');
        return h1?.textContent?.trim() || '';
      });
      console.log(`   -> Tiêu đề trang: "${pageTitle}"`);

      if (pageTitle.includes('Doanh số') || pageTitle.includes('Doanh thu')) {
        return true;
      }
    }

    // Fallback: Thử click trực tiếp vào menu
    console.log(`   -> Fallback: Click menu trực tiếp...`);

    // Bước 1: Click "Quản lý đơn hàng" để mở submenu
    await page.evaluate(() => {
      const menuItems = document.querySelectorAll('div, span, li');
      for (const item of menuItems) {
        if (item.textContent?.trim() === 'Quản lý đơn hàng') {
          item.click();
          return true;
        }
      }
      return false;
    });
    await delay(1500);

    // Bước 2: Click link "Doanh thu"
    const clicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent?.trim() === 'Doanh thu') {
          // Sử dụng click event thay vì .click()
          const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          link.dispatchEvent(event);
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log(`   -> Đã click "Doanh thu"`);
      await delay(3000);
      return true;
    }

    console.log(`   -> Không tìm thấy cách vào trang Doanh thu`);
    return false;
  } catch (error) {
    console.log(`   [WARN] Không thể navigate qua menu: ${error.message}`);
    return false;
  }
}

async function extractOrders(page) {
  await delay(2000);

  return await page.evaluate(() => {
    const orders = [];

    // Thử nhiều selector khác nhau
    let rows = document.querySelectorAll("table tbody tr");

    // Fallback 1: table tr (không có tbody)
    if (rows.length === 0) {
      rows = document.querySelectorAll("table tr");
    }

    // Fallback 2: div table structure
    if (rows.length === 0) {
      rows = document.querySelectorAll("[class*='table'] [class*='row'], [class*='ant-table'] tr");
    }

    console.log('Found rows:', rows.length);

    rows.forEach((row, index) => {
      const cells = row.querySelectorAll("td");

      // Skip header row
      if (cells.length === 0) return;

      // Có thể có 7 hoặc 8 cột
      if (cells.length >= 6) {
        const order = {
          stt: cells[0]?.textContent?.trim(),
          nhaHang: cells[1]?.textContent?.trim(),
          soLuongDon: cells[2]?.textContent?.trim(),
          tongTienTruocChietKhau: cells[3]?.textContent?.trim(),
          khuyenMai: cells[4]?.textContent?.trim(),
          phiDichVu: cells[5]?.textContent?.trim(),
          thueKhauTru: cells[6]?.textContent?.trim() || '',
          tongTien: cells[7]?.textContent?.trim() || '',
        };
        if (order.stt && order.stt !== "Stt") {
          orders.push(order);
        }
      }
    });

    return orders;
  });
}

async function extractAllPages(page) {
  let allOrders = [];
  let currentPage = 1;
  const maxPages = 50; // Giới hạn để tránh loop vô hạn

  while (currentPage <= maxPages) {
    const orders = await extractOrders(page);
    allOrders = allOrders.concat(orders);

    // Kiểm tra có trang tiếp theo không
    const hasNextPage = await page.evaluate(() => {
      const nextBtn = document.querySelector('[class*="next"]:not([disabled]), .pagination li:last-child:not(.disabled) a');
      return !!nextBtn;
    });

    if (!hasNextPage || orders.length === 0) break;

    // Click next page
    await page.evaluate(() => {
      const nextBtn = document.querySelector('[class*="next"]:not([disabled]), .pagination li:last-child:not(.disabled) a');
      if (nextBtn) nextBtn.click();
    });

    await delay(2000);
    currentPage++;
  }

  return allOrders;
}

// ========== MAIN API: Lấy đơn hàng ==========
app.post("/api/shopee/orders", async (req, res) => {
  const { userId, phone, password, fromDate, toDate, storeId, storeName, headless = true } = req.body;

  if (!userId || !phone || !password) {
    return res.status(400).json({
      success: false,
      error: "Thiếu userId, phone hoặc password",
    });
  }

  // Kiểm tra số lượng browser đang chạy
  if (currentRunning >= MAX_CONCURRENT) {
    return res.status(429).json({
      success: false,
      error: "Server đang bận, vui lòng thử lại sau",
      queuePosition: requestQueue.length + 1,
    });
  }

  let browser;
  let page;
  currentRunning++;

  try {
    console.log(`\n[${userId}] Bắt đầu lấy đơn hàng...`);
    console.log(`   -> Running: ${currentRunning}/${MAX_CONCURRENT}`);

    browser = await createBrowser(userId, headless);
    page = await browser.newPage();

    // Thiết lập stealth mode để tránh bị detect
    await setupStealthPage(page);

    console.log(`   -> Vào trang Shopee Partner...`);
    await page.goto("https://partner.shopee.vn/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(3000);

    let status = await checkLoginStatus(page);
    console.log(`   -> Trạng thái: ${status}`);

    // ===== 1. CẦN ĐĂNG NHẬP =====
    if (status === "NEED_LOGIN") {
      console.log(`   -> Đang đăng nhập với SĐT: ${phone.substring(0, 4)}****`);

      // Nhập số điện thoại
      const phoneInput = await page.$('input[type="tel"], input[type="text"]:first-of-type');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await delay(200);
        await phoneInput.type(phone, { delay: 50 });
      }

      // Nhập mật khẩu
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click();
        await delay(200);
        await passInput.type(password, { delay: 50 });
      }

      // Click nút đăng nhập
      await delay(500);
      const loginBtn = await page.$('button[type="submit"]');
      if (loginBtn) {
        await loginBtn.click();
      } else {
        // Tìm button có text "Đăng nhập"
        const buttons = await page.$$("button");
        for (const btn of buttons) {
          const text = await page.evaluate((el) => el.textContent?.trim(), btn);
          if (text && text.includes("Đăng nhập")) {
            await btn.click();
            break;
          }
        }
      }

      await delay(5000);
      status = await checkLoginStatus(page);
      console.log(`   -> Sau đăng nhập: ${status}`);
    }

    // ===== 2. CẦN OTP =====
    if (status === "NEED_OTP") {
      console.log(`   -> Cần xác thực OTP trên điện thoại...`);

      const sessionId = `${userId}_${Date.now()}`;
      activeSessions.set(sessionId, {
        browser,
        page,
        userId,
        fromDate,
        toDate,
        storeId,
        storeName,
        createdAt: Date.now()
      });

      // Tự động xóa session sau 3 phút
      setTimeout(async () => {
        const session = activeSessions.get(sessionId);
        if (session) {
          try {
            await session.browser.close();
          } catch (e) {}
          activeSessions.delete(sessionId);
          currentRunning--;
        }
      }, 180000);

      return res.json({
        success: false,
        needOTP: true,
        sessionId: sessionId,
        message: "Vui lòng xác nhận đăng nhập trên app Shopee trong điện thoại",
        expiresIn: 180,
      });
    }

    // ===== 3. CẦN CLICK TIẾP TỤC =====
    if (status === "NEED_CONTINUE") {
      console.log(`   -> Click nút Tiếp tục...`);
      await clickContinueButton(page);
      await delay(3000);
      status = await checkLoginStatus(page);
      console.log(`   -> Sau khi click Tiếp tục: ${status}`);
    }

    // ===== 4. CẦN CHỌN CỬA HÀNG =====
    if (status === "NEED_SELECT_STORE") {
      console.log(`   -> Đang ở trang chọn cửa hàng...`);

      const stores = await getStoreList(page);
      console.log(`   -> Tìm thấy ${stores.length} cửa hàng`);

      if (storeId !== undefined || storeName) {
        await selectStore(page, storeId, storeName);
        await delay(3000);
        status = await checkLoginStatus(page);
      } else {
        const sessionId = `${userId}_${Date.now()}`;
        activeSessions.set(sessionId, {
          browser,
          page,
          userId,
          fromDate,
          toDate,
          createdAt: Date.now()
        });

        // Tự động xóa session sau 3 phút
        setTimeout(async () => {
          const session = activeSessions.get(sessionId);
          if (session) {
            try {
              await session.browser.close();
            } catch (e) {}
            activeSessions.delete(sessionId);
            currentRunning--;
          }
        }, 180000);

        return res.json({
          success: false,
          needSelectStore: true,
          sessionId: sessionId,
          stores: stores,
          message: "Vui lòng chọn cửa hàng",
          expiresIn: 180,
        });
      }
    }

    // ===== 5. ĐÃ ĐĂNG NHẬP - LẤY ĐƠN HÀNG =====
    // Navigate qua menu thay vì URL trực tiếp
    await navigateToReportPage(page);
    await delay(2000);

    // Set date range nếu có
    if (fromDate && toDate) {
      console.log(`   -> Set ngày: ${fromDate} - ${toDate}`);
      await setDateRange(page, fromDate, toDate);
    }

    // Extract đơn hàng (có thể nhiều trang)
    const orders = await extractAllPages(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();
    currentRunning--;

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
      dateRange: { from: fromDate, to: toDate },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log(`   [ERROR] ${error.message}`);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    currentRunning--;
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Xác nhận OTP (sau khi user confirm trên điện thoại) ==========
app.post("/api/shopee/confirm-otp", async (req, res) => {
  const { sessionId } = req.body;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({
      success: false,
      error: "Session không tồn tại hoặc đã hết hạn",
    });
  }

  const { browser, page, userId, fromDate, toDate, storeId, storeName } = session;

  try {
    console.log(`\n[${userId}] Kiểm tra xác nhận OTP...`);
    await delay(2000);

    let status = await checkLoginStatus(page);
    console.log(`   -> Trạng thái: ${status}`);

    if (status === "NEED_OTP") {
      return res.json({
        success: false,
        needOTP: true,
        sessionId: sessionId,
        message: "OTP chưa được xác nhận, vui lòng xác nhận trên điện thoại",
      });
    }

    if (status === "NEED_CONTINUE") {
      await clickContinueButton(page);
      await delay(3000);
      status = await checkLoginStatus(page);
    }

    if (status === "NEED_SELECT_STORE") {
      const stores = await getStoreList(page);

      if (storeId !== undefined || storeName) {
        await selectStore(page, storeId, storeName);
      } else {
        return res.json({
          success: false,
          needSelectStore: true,
          sessionId: sessionId,
          stores: stores,
          message: "Vui lòng chọn cửa hàng",
        });
      }
    }

    // Vào trang báo cáo qua menu
    await navigateToReportPage(page);
    await delay(2000);

    // Set date range nếu có
    if (fromDate && toDate) {
      await setDateRange(page, fromDate, toDate);
    }

    const orders = await extractAllPages(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();
    activeSessions.delete(sessionId);
    currentRunning--;

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
      dateRange: { from: fromDate, to: toDate },
    });
  } catch (error) {
    console.log(`   [ERROR] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Chọn cửa hàng ==========
app.post("/api/shopee/select-store", async (req, res) => {
  const { sessionId, storeIndex = 0, storeName } = req.body;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({
      success: false,
      error: "Session không tồn tại hoặc đã hết hạn"
    });
  }

  const { browser, page, userId, fromDate, toDate } = session;

  try {
    console.log(`\n[${userId}] Chọn cửa hàng index: ${storeIndex}...`);

    await selectStore(page, storeIndex, storeName);
    await delay(3000);

    // Vào trang báo cáo qua menu
    await navigateToReportPage(page);
    await delay(2000);

    // Set date range nếu có
    if (fromDate && toDate) {
      await setDateRange(page, fromDate, toDate);
    }

    const orders = await extractAllPages(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();
    activeSessions.delete(sessionId);
    currentRunning--;

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
      dateRange: { from: fromDate, to: toDate },
    });
  } catch (error) {
    console.log(`   [ERROR] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Lấy danh sách cửa hàng ==========
app.post("/api/shopee/stores", async (req, res) => {
  const { userId, phone, password, headless = true } = req.body;

  if (!userId || !phone || !password) {
    return res.status(400).json({
      success: false,
      error: "Thiếu userId, phone hoặc password",
    });
  }

  let browser;
  let page;

  try {
    browser = await createBrowser(userId, headless);
    page = await browser.newPage();

    // Thiết lập stealth mode
    await setupStealthPage(page);

    await page.goto("https://partner.shopee.vn/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(3000);

    let status = await checkLoginStatus(page);

    // Login nếu cần
    if (status === "NEED_LOGIN") {
      const phoneInput = await page.$('input[type="tel"], input[type="text"]:first-of-type');
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phone, { delay: 50 });
      }
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.type(password, { delay: 50 });
      }
      const loginBtn = await page.$('button[type="submit"]');
      if (loginBtn) await loginBtn.click();
      await delay(5000);
      status = await checkLoginStatus(page);
    }

    if (status === "NEED_CONTINUE") {
      await clickContinueButton(page);
      await delay(3000);
      status = await checkLoginStatus(page);
    }

    if (status === "NEED_SELECT_STORE") {
      const stores = await getStoreList(page);
      await browser.close();
      return res.json({
        success: true,
        stores: stores,
      });
    }

    await browser.close();
    return res.json({
      success: false,
      error: "Không thể lấy danh sách cửa hàng",
      status: status,
    });
  } catch (error) {
    if (browser) try { await browser.close(); } catch (e) {}
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Health check ==========
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: activeSessions.size,
    currentRunning: currentRunning,
    maxConcurrent: MAX_CONCURRENT,
    uptime: process.uptime(),
  });
});

// ========== API: Xóa session thủ công ==========
app.delete("/api/shopee/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (session) {
    try {
      await session.browser.close();
    } catch (e) {}
    activeSessions.delete(sessionId);
    currentRunning--;
    return res.json({ success: true, message: "Session đã được xóa" });
  }

  return res.status(404).json({ success: false, error: "Session không tồn tại" });
});

// ========== API: Nhận dữ liệu từ Chrome Extension ==========
// Lưu trữ dữ liệu từ extension
const extensionData = new Map();

// CORS middleware cho extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Nhận dữ liệu từ extension
app.post("/api/extension/orders", (req, res) => {
  const { userId, orders, total, storeName, dateRange, extractedAt } = req.body;

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Thiếu userId"
    });
  }

  // Lưu dữ liệu
  const dataKey = `${userId}_${Date.now()}`;
  extensionData.set(dataKey, {
    userId,
    orders,
    total,
    storeName,
    dateRange,
    extractedAt,
    receivedAt: new Date().toISOString()
  });

  console.log(`\n========== [Extension] Nhận dữ liệu ==========`);
  console.log(`User ID: ${userId}`);
  console.log(`Store: ${storeName}`);
  console.log(`Date range: ${dateRange?.from} - ${dateRange?.to}`);
  console.log(`Extracted at: ${extractedAt}`);
  console.log(`Total orders: ${orders?.length || 0}`);
  console.log(`\n--- Chi tiết đơn hàng ---`);
  if (orders && orders.length > 0) {
    orders.forEach((order, index) => {
      console.log(`[${index + 1}] ${order.nhaHang || 'N/A'}`);
      console.log(`    Số lượng đơn: ${order.soLuongDon}`);
      console.log(`    Tổng tiền trước CK: ${order.tongTienTruocChietKhau}`);
      console.log(`    Khuyến mãi: ${order.khuyenMai}`);
      console.log(`    Phí dịch vụ: ${order.phiDichVu}`);
      console.log(`    Thuế khấu trừ: ${order.thueKhauTru}`);
      console.log(`    Tổng tiền: ${order.tongTien}`);
    });
  } else {
    console.log(`(Không có đơn hàng)`);
  }
  console.log(`\n--- Raw JSON ---`);
  console.log(JSON.stringify(req.body, null, 2));
  console.log(`================================================\n`);

  // Giữ data trong 1 giờ
  setTimeout(() => {
    extensionData.delete(dataKey);
  }, 3600000);

  return res.json({
    success: true,
    message: `Đã nhận ${orders?.length || 0} đơn hàng`,
    dataKey: dataKey
  });
});

// Lấy dữ liệu đã nhận từ extension
app.get("/api/extension/orders/:userId", (req, res) => {
  const { userId } = req.params;

  // Tìm tất cả data của user này
  const userData = [];
  extensionData.forEach((data, key) => {
    if (data.userId === userId) {
      userData.push({ key, ...data });
    }
  });

  if (userData.length === 0) {
    return res.status(404).json({
      success: false,
      error: "Không tìm thấy dữ liệu của user này"
    });
  }

  // Trả về data mới nhất
  userData.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

  return res.json({
    success: true,
    data: userData[0],
    allData: userData
  });
});

// Lấy tất cả dữ liệu extension đã nhận
app.get("/api/extension/orders", (req, res) => {
  const allData = [];
  extensionData.forEach((data, key) => {
    allData.push({ key, ...data });
  });

  return res.json({
    success: true,
    total: allData.length,
    data: allData
  });
});

// ========== API: Gọi trực tiếp Shopee API (forward all headers) ==========
app.post("/api/shopee/direct/orders", async (req, res) => {
  const {
    // Shopee headers - forward tất cả từ client
    headers: shopeeHeaders,
    // Request body
    orderFilterType = 30,
    requestCount = 50,
    sortType = 6,
    nextItemId = ""
  } = req.body;

  if (!shopeeHeaders || !shopeeHeaders["x-foody-access-token"]) {
    return res.status(400).json({
      success: false,
      error: "Thiếu headers. Cần forward tất cả headers từ Shopee app"
    });
  }

  console.log(`\n========== [Direct API] Gọi Shopee API ==========`);
  console.log(`Entity ID: ${shopeeHeaders["x-foody-entity-id"]}`);
  console.log(`Has x-sap-sec: ${!!shopeeHeaders["x-sap-sec"]}`);
  console.log(`Has spc-b-oft: ${!!shopeeHeaders["spc-b-oft"]}`);

  // Build final headers
  const finalHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    ...shopeeHeaders
  };

  try {
    const response = await fetch("https://gmerchant.deliverynow.vn/api/v5/order/get_list", {
      method: "POST",
      headers: finalHeaders,
      body: JSON.stringify({
        order_filter_type: orderFilterType,
        next_item_id: nextItemId,
        request_count: requestCount,
        sort_type: sortType
      })
    });

    const data = await response.json();

    console.log(`Response status: ${response.status}`);
    console.log(`Response data:`, JSON.stringify(data, null, 2));
    console.log(`================================================\n`);

    return res.json({
      success: true,
      statusCode: response.status,
      data: data
    });
  } catch (error) {
    console.log(`Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== API: Nhận data từ iOS Shortcut ==========
app.post("/api/shortcut/orders", (req, res) => {
  const { userId, entityId, accessToken, orders } = req.body;

  console.log(`\n========== [iOS Shortcut] Nhận dữ liệu ==========`);
  console.log(`User ID: ${userId}`);
  console.log(`Entity ID: ${entityId}`);
  console.log(`Orders count: ${orders?.data?.length || orders?.length || 0}`);
  console.log(`Raw data:`, JSON.stringify(req.body, null, 2));
  console.log(`================================================\n`);

  // Lưu data
  const dataKey = `shortcut_${userId}_${Date.now()}`;
  extensionData.set(dataKey, {
    userId,
    entityId,
    source: 'ios-shortcut',
    data: orders,
    receivedAt: new Date().toISOString()
  });

  // Auto cleanup sau 1 giờ
  setTimeout(() => extensionData.delete(dataKey), 3600000);

  return res.json({
    success: true,
    message: `Đã nhận data từ iOS Shortcut`,
    dataKey: dataKey
  });
});

// ========== QUẢN LÝ KHÁCH HÀNG - CRUD APIs ==========

// Lấy danh sách khách hàng
app.get("/api/customers", (req, res) => {
  const customers = loadCustomers();
  // Ẩn token khi trả về
  const safeCustomers = customers.map(c => ({
    ...c,
    accessToken: c.accessToken ? `${c.accessToken.substring(0, 10)}...` : null
  }));

  return res.json({
    success: true,
    total: customers.length,
    customers: safeCustomers
  });
});

// Thêm khách hàng mới
app.post("/api/customers", (req, res) => {
  const {
    customerId,      // ID duy nhất (vd: "shop_001")
    name,            // Tên khách hàng
    entityId,        // x-foody-entity-id
    accessToken,     // x-foody-access-token
    xSfTraceId,      // x-sf-trace-id (optional)
    spcBOft,         // spc-b-oft (optional)
    userAgent = "language=vi app_type=29"
  } = req.body;

  if (!customerId || !entityId || !accessToken) {
    return res.status(400).json({
      success: false,
      error: "Thiếu customerId, entityId hoặc accessToken"
    });
  }

  const customers = loadCustomers();

  // Kiểm tra trùng
  if (customers.find(c => c.customerId === customerId)) {
    return res.status(400).json({
      success: false,
      error: "customerId đã tồn tại"
    });
  }

  const newCustomer = {
    customerId,
    name: name || customerId,
    entityId,
    accessToken,
    xSfTraceId: xSfTraceId || "",
    spcBOft: spcBOft || "",
    userAgent,
    createdAt: new Date().toISOString(),
    lastFetch: null,
    status: "active"
  };

  customers.push(newCustomer);
  saveCustomers(customers);

  console.log(`[Customer] Thêm mới: ${customerId} (${name})`);

  return res.json({
    success: true,
    message: "Đã thêm khách hàng",
    customer: { ...newCustomer, accessToken: `${accessToken.substring(0, 10)}...` }
  });
});

// Cập nhật khách hàng
app.put("/api/customers/:customerId", (req, res) => {
  const { customerId } = req.params;
  const updates = req.body;

  const customers = loadCustomers();
  const index = customers.findIndex(c => c.customerId === customerId);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "Không tìm thấy khách hàng"
    });
  }

  // Cập nhật các field được phép
  const allowedFields = ['name', 'entityId', 'accessToken', 'xSfTraceId', 'spcBOft', 'userAgent', 'status'];
  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      customers[index][field] = updates[field];
    }
  });
  customers[index].updatedAt = new Date().toISOString();

  saveCustomers(customers);
  console.log(`[Customer] Cập nhật: ${customerId}`);

  return res.json({
    success: true,
    message: "Đã cập nhật khách hàng"
  });
});

// Xóa khách hàng
app.delete("/api/customers/:customerId", (req, res) => {
  const { customerId } = req.params;

  let customers = loadCustomers();
  const index = customers.findIndex(c => c.customerId === customerId);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "Không tìm thấy khách hàng"
    });
  }

  customers.splice(index, 1);
  saveCustomers(customers);
  console.log(`[Customer] Xóa: ${customerId}`);

  return res.json({
    success: true,
    message: "Đã xóa khách hàng"
  });
});

// ========== FETCH ĐƠN HÀNG TỰ ĐỘNG ==========

// Hàm gọi API Shopee cho 1 khách hàng (dùng Shortcut trên macOS)
async function fetchOrdersForCustomer(customer) {
  const {
    customerId,
    entityId,
    accessToken,
    xSfTraceId,
    spcBOft,
    userAgent
  } = customer;

  console.log(`\n[Auto-Fetch] Đang fetch cho: ${customerId}...`);

  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "user-agent": userAgent || "language=vi app_type=29",
      "x-foody-client-id": "CD1C90F850C14104827124E1AC7F263A",
      "x-foody-access-token": accessToken,
      "x-foody-entity-id": entityId,
      "x-foody-client-type": "1",
      "x-foody-app-type": "1024",
      "x-foody-api-version": "1",
      "x-foody-client-language": "vi",
      "x-foody-client-version": "3.0.0"
    };

    // Thêm optional headers nếu có
    if (xSfTraceId) headers["x-sf-trace-id"] = xSfTraceId;
    if (spcBOft) headers["spc-b-oft"] = spcBOft;

    const response = await fetch("https://gmerchant.deliverynow.vn/api/v5/order/get_list", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        order_filter_type: 31,
        next_item_id: "",
        request_count: 50,
        sort_type: 5
      })
    });

    const data = await response.json();

    // Lưu kết quả
    const result = {
      customerId,
      success: data.code === 0,
      ordersCount: data.data?.length || 0,
      data: data,
      fetchedAt: new Date().toISOString()
    };

    fetchResults.set(customerId, result);

    // Cập nhật lastFetch trong customers
    const customers = loadCustomers();
    const idx = customers.findIndex(c => c.customerId === customerId);
    if (idx !== -1) {
      customers[idx].lastFetch = new Date().toISOString();
      customers[idx].lastFetchStatus = data.code === 0 ? "success" : "failed";
      customers[idx].lastOrdersCount = data.data?.length || 0;
      saveCustomers(customers);
    }

    console.log(`[Auto-Fetch] ${customerId}: ${data.code === 0 ? 'OK' : 'FAILED'} - ${data.data?.length || 0} đơn`);

    return result;
  } catch (error) {
    console.log(`[Auto-Fetch] ${customerId}: ERROR - ${error.message}`);

    const result = {
      customerId,
      success: false,
      error: error.message,
      fetchedAt: new Date().toISOString()
    };
    fetchResults.set(customerId, result);

    return result;
  }
}

// Fetch tất cả khách hàng
async function fetchAllCustomers() {
  const customers = loadCustomers().filter(c => c.status === "active");

  if (customers.length === 0) {
    console.log("[Auto-Fetch] Không có khách hàng active");
    return [];
  }

  console.log(`\n========== [Auto-Fetch] Bắt đầu fetch ${customers.length} khách hàng ==========`);

  const results = [];

  // Fetch tuần tự để tránh bị rate limit
  for (const customer of customers) {
    const result = await fetchOrdersForCustomer(customer);
    results.push(result);

    // Delay 2 giây giữa mỗi request
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`========== [Auto-Fetch] Hoàn thành: ${successCount}/${customers.length} thành công ==========\n`);

  return results;
}

// API: Fetch thủ công tất cả khách hàng
app.post("/api/customers/fetch-all", async (req, res) => {
  const results = await fetchAllCustomers();

  return res.json({
    success: true,
    total: results.length,
    successCount: results.filter(r => r.success).length,
    results: results
  });
});

// API: Fetch 1 khách hàng cụ thể
app.post("/api/customers/:customerId/fetch", async (req, res) => {
  const { customerId } = req.params;

  const customers = loadCustomers();
  const customer = customers.find(c => c.customerId === customerId);

  if (!customer) {
    return res.status(404).json({
      success: false,
      error: "Không tìm thấy khách hàng"
    });
  }

  const result = await fetchOrdersForCustomer(customer);

  return res.json(result);
});

// API: Lấy kết quả fetch gần nhất
app.get("/api/customers/:customerId/orders", (req, res) => {
  const { customerId } = req.params;

  const result = fetchResults.get(customerId);

  if (!result) {
    return res.status(404).json({
      success: false,
      error: "Chưa có dữ liệu. Hãy fetch trước."
    });
  }

  return res.json(result);
});

// API: Lấy tất cả kết quả fetch
app.get("/api/orders/all", (req, res) => {
  const allResults = [];
  fetchResults.forEach((value, key) => {
    allResults.push(value);
  });

  return res.json({
    success: true,
    total: allResults.length,
    results: allResults
  });
});

// ========== AUTO FETCH ĐỊNH KỲ ==========
let autoFetchInterval = null;

// API: Bật auto-fetch
app.post("/api/auto-fetch/start", (req, res) => {
  const { intervalMinutes = 5 } = req.body;

  if (autoFetchInterval) {
    clearInterval(autoFetchInterval);
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  autoFetchInterval = setInterval(async () => {
    await fetchAllCustomers();
  }, intervalMs);

  console.log(`[Auto-Fetch] Đã bật auto-fetch mỗi ${intervalMinutes} phút`);

  // Fetch ngay lập tức lần đầu
  fetchAllCustomers();

  return res.json({
    success: true,
    message: `Auto-fetch đã bật, chạy mỗi ${intervalMinutes} phút`
  });
});

// API: Tắt auto-fetch
app.post("/api/auto-fetch/stop", (req, res) => {
  if (autoFetchInterval) {
    clearInterval(autoFetchInterval);
    autoFetchInterval = null;
    console.log("[Auto-Fetch] Đã tắt auto-fetch");
  }

  return res.json({
    success: true,
    message: "Auto-fetch đã tắt"
  });
});

// API: Trạng thái auto-fetch
app.get("/api/auto-fetch/status", (req, res) => {
  return res.json({
    success: true,
    isRunning: autoFetchInterval !== null,
    customersCount: loadCustomers().filter(c => c.status === "active").length,
    resultsCount: fetchResults.size
  });
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Max concurrent browsers: ${MAX_CONCURRENT}`);
});
