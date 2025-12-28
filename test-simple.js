const puppeteer = require("puppeteer");

async function testSimple() {
  console.log("🚀 Bắt đầu test đơn giản...");

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1366,768",
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();

  console.log("📱 Vào trang Shopee Partner...");
  await page.goto("https://partner.shopee.vn/", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  console.log("✅ Đã vào trang, đợi 60 giây để bạn đăng nhập thủ công...");
  console.log("👉 Sau khi đăng nhập và vào trang Doanh thu, nhấn Ctrl+C để dừng");

  // Đợi để bạn đăng nhập thủ công
  await new Promise((r) => setTimeout(r, 60000));

  // Lấy URL hiện tại
  const currentUrl = page.url();
  console.log(`📍 URL hiện tại: ${currentUrl}`);

  // Thử extract data
  const tableData = await page.evaluate(() => {
    const rows = document.querySelectorAll("table tbody tr, table tr");
    console.log("Found rows:", rows.length);
    return Array.from(rows).map((row) => {
      const cells = row.querySelectorAll("td");
      return Array.from(cells).map((cell) => cell.textContent?.trim());
    });
  });

  console.log("📊 Dữ liệu bảng:");
  console.log(JSON.stringify(tableData, null, 2));

  await browser.close();
  console.log("✅ Done!");
}

testSimple().catch(console.error);
