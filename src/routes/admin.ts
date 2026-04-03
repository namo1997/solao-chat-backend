import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import axios from "axios";

const router = Router();
const prisma = new PrismaClient();

// ─── Dashboard Stats ──────────────────────────────────────────────────────────
router.get("/stats", async (_req: Request, res: Response) => {
  const [totalConversations, openConversations, totalMessages, totalComments, pendingReservations] =
    await Promise.all([
      prisma.conversation.count(),
      prisma.conversation.count({ where: { status: "open" } }),
      prisma.message.count(),
      prisma.facebookComment.count(),
      prisma.reservation.count({ where: { status: "pending" } }),
    ]);

  res.json({
    totalConversations,
    openConversations,
    totalMessages,
    totalComments,
    pendingReservations,
  });
});

// ─── Conversations ────────────────────────────────────────────────────────────
router.get("/conversations", async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;

  const where = status ? { status } : {};

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        customer: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.conversation.count({ where }),
  ]);

  res.json({ conversations, total, page, limit });
});

router.get("/conversations/:id", async (req: Request, res: Response) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      messages: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json(conversation);
});

// อัปเดต status conversation
router.patch("/conversations/:id", async (req: Request, res: Response) => {
  const { status, isAiEnabled } = req.body;

  const conversation = await prisma.conversation.update({
    where: { id: req.params.id },
    data: {
      ...(status && { status }),
      ...(isAiEnabled !== undefined && { isAiEnabled }),
    },
  });

  res.json(conversation);
});

// ส่งข้อความจาก Admin
router.post("/conversations/:id/send", async (req: Request, res: Response) => {
  const { message } = req.body;
  const conversationId = req.params.id;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: true },
  });

  if (!conversation || !conversation.customer.facebookId) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  // ส่ง Messenger
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages`,
    {
      recipient: { id: conversation.customer.facebookId },
      message: { text: message },
      messaging_type: "RESPONSE",
    },
    { params: { access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN } }
  );

  // บันทึกข้อความ
  const saved = await prisma.message.create({
    data: {
      conversationId,
      sender: "admin",
      content: message,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessage: message, lastMessageAt: new Date() },
  });

  res.json(saved);
});

// ─── Comments ─────────────────────────────────────────────────────────────────
router.get("/comments", async (req: Request, res: Response) => {
  const status = req.query.status as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const where = status ? { status } : {};

  const [comments, total] = await Promise.all([
    prisma.facebookComment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.facebookComment.count({ where }),
  ]);

  res.json({ comments, total });
});

// ─── Reservations ─────────────────────────────────────────────────────────────
router.get("/reservations", async (req: Request, res: Response) => {
  const status = req.query.status as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const where = status ? { status } : {};

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      orderBy: { date: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.reservation.count({ where }),
  ]);

  res.json({ reservations, total });
});

router.patch("/reservations/:id", async (req: Request, res: Response) => {
  const { status, notes } = req.body;

  const reservation = await prisma.reservation.update({
    where: { id: req.params.id },
    data: {
      ...(status && { status }),
      ...(notes !== undefined && { notes }),
    },
  });

  res.json(reservation);
});

// ─── Knowledge Base ───────────────────────────────────────────────────────────
router.get("/knowledge", async (_req: Request, res: Response) => {
  const items = await prisma.knowledgeItem.findMany({
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
  res.json(items);
});

router.post("/knowledge", async (req: Request, res: Response) => {
  const { category, title, content } = req.body;
  const item = await prisma.knowledgeItem.create({
    data: { category, title, content },
  });
  res.json(item);
});

router.put("/knowledge/:id", async (req: Request, res: Response) => {
  const { category, title, content, isActive } = req.body;
  const item = await prisma.knowledgeItem.update({
    where: { id: req.params.id },
    data: { category, title, content, isActive },
  });
  res.json(item);
});

router.delete("/knowledge/:id", async (req: Request, res: Response) => {
  await prisma.knowledgeItem.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

export default router;
