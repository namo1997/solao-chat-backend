import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import facebookWebhook from "./webhooks/facebook";
import adminRouter from "./routes/admin";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
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
