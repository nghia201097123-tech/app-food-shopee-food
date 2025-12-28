const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PROFILES_DIR = "./profiles";
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
      "--window-size=1200,800",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    defaultViewport: { width: 1200, height: 800 },
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

  return await puppeteer.launch(launchOptions);
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

async function extractOrders(page) {
  await delay(2000);

  return await page.evaluate(() => {
    const orders = [];
    const rows = document.querySelectorAll("table tbody tr");

    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 7) {
        const order = {
          stt: cells[0]?.textContent?.trim(),
          nhaHang: cells[1]?.textContent?.trim(),
          soLuongDon: cells[2]?.textContent?.trim(),
          tongTienTruocChietKhau: cells[3]?.textContent?.trim(),
          khuyenMai: cells[4]?.textContent?.trim(),
          phiDichVu: cells[5]?.textContent?.trim(),
          thueKhauTru: cells[6]?.textContent?.trim(),
          tongTien: cells[7]?.textContent?.trim(),
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

    // Set user agent để tránh bị detect
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

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
    console.log(`   -> Vào trang báo cáo doanh thu...`);
    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(3000);

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

    // Vào trang báo cáo
    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
    });
    await delay(3000);

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

    // Vào trang báo cáo
    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
    });
    await delay(3000);

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

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Max concurrent browsers: ${MAX_CONCURRENT}`);
});
