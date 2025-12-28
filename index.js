const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PROFILES_DIR = "./profiles";
const activeSessions = new Map();

if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Helper delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ========== HELPER FUNCTIONS ==========

async function createBrowser(userId, headless = false) {
  const userDataDir = path.join(PROFILES_DIR, userId);

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  return await puppeteer.launch({
    headless: headless,
    userDataDir: userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1200,800",
    ],
    defaultViewport: { width: 1200, height: 800 },
  });
}

async function checkLoginStatus(page) {
  const url = page.url();
  const content = await page.content();

  if (
    url.includes("login") ||
    url.includes("auth") ||
    content.includes("Đăng nhập")
  ) {
    const hasLoginForm = await page.$('input[type="password"]');
    if (hasLoginForm) {
      return "NEED_LOGIN";
    }
  }

  const hasOTP = await page.$(
    'input[placeholder*="OTP"], input[placeholder*="mã xác"]'
  );
  if (hasOTP) {
    return "NEED_OTP";
  }

  const continueBtn = await page.$("button");
  if (continueBtn) {
    const btnText = await page.evaluate((el) => el.textContent, continueBtn);
    if (btnText && btnText.includes("Tiếp tục")) {
      return "NEED_CONTINUE";
    }
  }

  if (
    content.includes("Chọn đối tác") ||
    content.includes("Danh sách Đối tác")
  ) {
    return "NEED_SELECT_STORE";
  }

  return "LOGGED_IN";
}

async function extractOrders(page) {
  await delay(2000);

  return await page.evaluate(() => {
    const rows = document.querySelectorAll("table tbody tr");
    return Array.from(rows)
      .map((row) => {
        const cells = row.querySelectorAll("td");
        return {
          stt: cells[0]?.textContent?.trim(),
          nhaHang: cells[1]?.textContent?.trim(),
          soLuongDon: cells[2]?.textContent?.trim(),
          tongTien: cells[3]?.textContent?.trim(),
          khuyenMai: cells[4]?.textContent?.trim(),
          phiDichVu: cells[5]?.textContent?.trim(),
          thueKhauTru: cells[6]?.textContent?.trim(),
          tongTienFinal: cells[7]?.textContent?.trim(),
        };
      })
      .filter((row) => row.stt);
  });
}

// ========== MAIN API: Lấy đơn hàng ==========
app.post("/api/shopee/orders", async (req, res) => {
  const { userId, phone, password, fromDate, toDate, storeId } = req.body;

  if (!userId || !phone || !password) {
    return res.status(400).json({
      success: false,
      error: "Thiếu userId, phone hoặc password",
    });
  }

  let browser;
  let page;

  try {
    console.log(`\n[${userId}] Bắt đầu lấy đơn hàng...`);

    browser = await createBrowser(userId, false);
    page = await browser.newPage();

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
      console.log(`   -> Đang đăng nhập...`);

      const phoneInput = await page.$(
        'input[type="tel"], input[type="text"]:not([type="password"])'
      );
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(phone, { delay: 50 });
      }

      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.type(password, { delay: 50 });
      }

      const loginBtn = await page.$('button[type="submit"]');
      if (loginBtn) {
        await loginBtn.click();
      }

      await delay(5000);
      status = await checkLoginStatus(page);
      console.log(`   -> Sau đăng nhập: ${status}`);
    }

    // ===== 2. CẦN OTP =====
    if (status === "NEED_OTP") {
      console.log(`   -> Cần nhập OTP...`);

      const sessionId = `${userId}_${Date.now()}`;
      activeSessions.set(sessionId, { browser, page, userId });

      setTimeout(async () => {
        const session = activeSessions.get(sessionId);
        if (session) {
          try {
            await session.browser.close();
          } catch (e) {}
          activeSessions.delete(sessionId);
        }
      }, 180000);

      return res.json({
        success: false,
        needOTP: true,
        sessionId: sessionId,
        message: "Vui lòng nhập OTP trên điện thoại",
      });
    }

    // ===== 3. CẦN CLICK TIẾP TỤC =====
    if (status === "NEED_CONTINUE") {
      console.log(`   -> Click Tiếp tục...`);
      const btns = await page.$$("button");
      for (const btn of btns) {
        const text = await page.evaluate((el) => el.textContent, btn);
        if (text && text.includes("Tiếp tục")) {
          await btn.click();
          break;
        }
      }
      await delay(3000);
      status = await checkLoginStatus(page);
    }

    // ===== 4. CẦN CHỌN CỬA HÀNG =====
    if (status === "NEED_SELECT_STORE") {
      console.log(`   -> Cần chọn cửa hàng...`);

      const stores = await page.evaluate(() => {
        const result = [];
        document.querySelectorAll("div").forEach((div, index) => {
          const text = div.textContent;
          if (text && (text.includes("[Mới]") || text.includes("Quán"))) {
            if (text.length < 100) {
              result.push({ index, name: text.trim() });
            }
          }
        });
        return result.slice(0, 10);
      });

      if (storeId !== undefined) {
        const storeElements = await page.$$("div");
        for (const el of storeElements) {
          const text = await page.evaluate((e) => e.textContent, el);
          if (text && text.includes("[Mới]")) {
            await el.click();
            break;
          }
        }
        await delay(3000);
      } else {
        const sessionId = `${userId}_${Date.now()}`;
        activeSessions.set(sessionId, { browser, page, userId });

        return res.json({
          success: false,
          needSelectStore: true,
          sessionId: sessionId,
          stores: stores,
          message: "Vui lòng chọn cửa hàng",
        });
      }
    }

    // ===== 5. ĐÃ ĐĂNG NHẬP - LẤY ĐƠN HÀNG =====
    console.log(`   -> Vào trang báo cáo...`);
    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
    });
    await delay(3000);

    status = await checkLoginStatus(page);
    if (status !== "LOGGED_IN") {
      await browser.close();
      return res.json({
        success: false,
        error: `Không thể vào trang báo cáo. Status: ${status}`,
      });
    }

    const orders = await extractOrders(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log(`   [ERROR] Lỗi: ${error.message}`);
    if (browser)
      try {
        await browser.close();
      } catch (e) {}
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Xác nhận OTP ==========
app.post("/api/shopee/confirm-otp", async (req, res) => {
  const { sessionId } = req.body;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({
      success: false,
      error: "Session không tồn tại hoặc đã hết hạn",
    });
  }

  const { browser, page, userId } = session;

  try {
    console.log(`\n[${userId}] Xác nhận OTP...`);
    await delay(3000);

    let status = await checkLoginStatus(page);
    console.log(`   -> Trạng thái: ${status}`);

    if (status === "NEED_OTP") {
      return res.json({
        success: false,
        needOTP: true,
        sessionId: sessionId,
        message: "OTP chưa được xác nhận",
      });
    }

    if (status === "NEED_CONTINUE") {
      const btns = await page.$$("button");
      for (const btn of btns) {
        const text = await page.evaluate((el) => el.textContent, btn);
        if (text && text.includes("Tiếp tục")) {
          await btn.click();
          break;
        }
      }
      await delay(3000);
      status = await checkLoginStatus(page);
    }

    if (status === "NEED_SELECT_STORE") {
      return res.json({
        success: false,
        needSelectStore: true,
        sessionId: sessionId,
        message: "Vui lòng chọn cửa hàng",
      });
    }

    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
    });
    await delay(3000);

    const orders = await extractOrders(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();
    activeSessions.delete(sessionId);

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
    });
  } catch (error) {
    console.log(`   [ERROR] Lỗi: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== API: Chọn cửa hàng ==========
app.post("/api/shopee/select-store", async (req, res) => {
  const { sessionId, storeIndex } = req.body;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res
      .status(400)
      .json({ success: false, error: "Session không tồn tại" });
  }

  const { browser, page, userId } = session;

  try {
    console.log(`\n[${userId}] Chọn cửa hàng...`);

    const divs = await page.$$("div");
    for (const div of divs) {
      const text = await page.evaluate((el) => el.textContent, div);
      if (text && text.includes("[Mới]") && text.length < 100) {
        await div.click();
        break;
      }
    }

    await delay(3000);

    await page.goto("https://partner.shopee.vn/order/report-restaurant", {
      waitUntil: "networkidle2",
    });
    await delay(3000);

    const orders = await extractOrders(page);
    console.log(`   [OK] Lấy được ${orders.length} đơn hàng`);

    await browser.close();
    activeSessions.delete(sessionId);

    return res.json({
      success: true,
      orders: orders,
      total: orders.length,
    });
  } catch (error) {
    console.log(`   [ERROR] Lỗi: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
