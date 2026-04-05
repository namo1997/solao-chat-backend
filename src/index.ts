import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import facebookWebhook from "./webhooks/facebook";
import adminRouter from "./routes/admin";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Railway อยู่หลัง proxy — ต้องตั้งค่านี้ให้ express-rate-limit ทำงานถูกต้อง
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      // อนุญาต requests ที่ไม่มี origin (เช่น mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Facebook Webhook ต้องการ raw body สำหรับ signature verification
app.use(
  "/webhook/facebook",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    if (req.body && Buffer.isBuffer(req.body)) {
      (req as any).rawBody = req.body;
      req.body = JSON.parse(req.body.toString("utf-8"));
    }
    next();
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting สำหรับ Admin API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 100,
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/webhook/facebook", facebookWebhook);
app.use("/api/admin", apiLimiter, adminRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   🚀 Backend Server Started          ║
  ║   Port: ${PORT}                          ║
  ║   Webhook: /webhook/facebook         ║
  ║   Admin API: /api/admin              ║
  ╚══════════════════════════════════════╝
  `);
});

export default app;
