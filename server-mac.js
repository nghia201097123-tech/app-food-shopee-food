const express = require("express");
const { exec, execSync } = require("child_process");
const fs = require("fs");

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SHORTCUT_NAME = "ShopeeOrders";

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", platform: process.platform });
});

// API: Gọi Shortcut
app.post("/api/shortcut/fetch", async (req, res) => {
  const { entityId, accessToken } = req.body;

  if (!entityId || !accessToken) {
    return res.status(400).json({
      success: false,
      error: "Thiếu entityId hoặc accessToken",
    });
  }

  console.log(`\n[Shortcut] Fetching for entityId: ${entityId}`);

  const timestamp = Date.now();
  const inputFile = `/tmp/shopee_input_${timestamp}.json`;
  const outputFile = `/tmp/shopee_out_${timestamp}.json`;

  // Ghi JSON vào file (tránh lỗi với ký tự đặc biệt như /)
  const inputJson = JSON.stringify({ entityId, accessToken });
  fs.writeFileSync(inputFile, inputJson);

  // Dùng cat để copy file vào clipboard (an toàn với mọi ký tự)
  const cmd = `cat "${inputFile}" | pbcopy && shortcuts run "${SHORTCUT_NAME}" --output-path "${outputFile}"`;

  console.log(`[Shortcut] Running command...`);

  try {
    // Dùng execSync để chờ kết quả
    execSync(cmd, { timeout: 30000, encoding: "utf8" });

    // Cleanup input file
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);

    if (fs.existsSync(outputFile)) {
      const output = fs.readFileSync(outputFile, "utf8");
      const data = JSON.parse(output);

      // Cleanup output file
      fs.unlinkSync(outputFile);

      console.log(`[Shortcut] Success: code=${data.code}`);

      return res.json({
        success: data.code === 0,
        data: data,
      });
    } else {
      console.log(`[Shortcut] Error: No output file`);
      return res.status(500).json({
        success: false,
        error: "Shortcut không trả về output",
      });
    }
  } catch (error) {
    console.log(`[Shortcut] Error: ${error.message}`);

    // Cleanup input file
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);

    // Kiểm tra nếu output file vẫn tồn tại (shortcut có thể đã chạy nhưng có warning)
    if (fs.existsSync(outputFile)) {
      try {
        const output = fs.readFileSync(outputFile, "utf8");
        const data = JSON.parse(output);
        fs.unlinkSync(outputFile);

        return res.json({
          success: data.code === 0,
          data: data,
        });
      } catch (e) {
        // Ignore
      }
    }

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// API: Test command đơn giản
app.get("/api/test-cmd", (req, res) => {
  try {
    const result = execSync("echo 'hello' | pbcopy && pbpaste", {
      encoding: "utf8",
    });
    res.json({ success: true, result: result.trim() });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// API: List shortcuts
app.get("/api/shortcuts", (req, res) => {
  try {
    const result = execSync("shortcuts list", { encoding: "utf8" });
    const shortcuts = result.trim().split("\n");
    res.json({ success: true, shortcuts });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`\nTest với:`);
  console.log(`curl http://localhost:${PORT}/api/health`);
  console.log(`curl http://localhost:${PORT}/api/test-cmd`);
  console.log(`curl http://localhost:${PORT}/api/shortcuts`);
});
