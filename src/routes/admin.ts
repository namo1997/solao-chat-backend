import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { replyEngine } from "../ai/reply-engine";

const router = Router();
const prisma = new PrismaClient();

function getParamId(rawId: string | string[] | undefined): string | null {
  if (typeof rawId === "string") return rawId;
  if (Array.isArray(rawId) && rawId.length > 0) return rawId[0];
  return null;
}

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
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid conversation id" });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id },
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
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid conversation id" });
  }

  const { status, isAiEnabled } = req.body;

  const conversation = await prisma.conversation.update({
    where: { id },
    data: {
      ...(status && { status }),
      ...(isAiEnabled !== undefined && { isAiEnabled }),
    },
  });

  res.json(conversation);
});

// ส่งข้อความจาก Admin
router.post("/conversations/:id/send", async (req: Request, res: Response) => {
  const conversationId = getParamId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Invalid conversation id" });
  }

  const { message } = req.body;

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

// สร้าง AI Draft สำหรับการตอบ Messenger (admin เลือกส่งหรือไม่)
router.post("/conversations/:id/generate-ai", async (req: Request, res: Response) => {
  const conversationId = getParamId(req.params.id);
  if (!conversationId) {
    return res.status(400).json({ error: "Invalid conversation id" });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: 10,
      },
    },
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const history = conversation.messages;
  const lastCustomerMsg = [...history].reverse().find((m) => m.sender === "customer");

  if (!lastCustomerMsg) {
    return res.status(400).json({ error: "No customer message found" });
  }

  const draft = await replyEngine.generateReply(lastCustomerMsg.content, history);

  if (!draft) {
    return res.status(500).json({ error: "AI failed to generate draft" });
  }

  res.json({ draft });
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

router.get("/comments/summary", async (_req: Request, res: Response) => {
  const [all, pending, replied, skipped] = await Promise.all([
    prisma.facebookComment.count(),
    prisma.facebookComment.count({ where: { status: "pending" } }),
    prisma.facebookComment.count({ where: { status: "replied" } }),
    prisma.facebookComment.count({ where: { status: "skipped" } }),
  ]);

  res.json({ all, pending, replied, skipped });
});

router.patch("/comments/:id", async (req: Request, res: Response) => {
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid comment id" });
  }

  const { status } = req.body as { status?: string };

  if (!status || !["pending", "replied", "skipped"].includes(status)) {
    return res
      .status(400)
      .json({ error: "Invalid status. Use pending | replied | skipped" });
  }

  const updated = await prisma.facebookComment.update({
    where: { id },
    data: {
      status,
      ...(status === "replied"
        ? { repliedAt: new Date() }
        : { repliedAt: null }),
    },
  });

  res.json(updated);
});

router.post("/comments/:id/generate-ai", async (req: Request, res: Response) => {
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid comment id" });
  }

  const comment = await prisma.facebookComment.findUnique({
    where: { id },
  });

  if (!comment) {
    return res.status(404).json({ error: "Comment not found" });
  }

  const aiReply = await replyEngine.generateCommentReply(
    comment.message,
    comment.senderName
  );

  if (!aiReply) {
    return res.status(500).json({ error: "AI failed to generate reply" });
  }

  await prisma.facebookComment.update({
    where: { id: comment.id },
    data: { aiReply },
  });

  res.json({ reply: aiReply });
});

router.post("/comments/:id/reply", async (req: Request, res: Response) => {
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid comment id" });
  }

  const { message } = req.body as { message?: string };
  const trimmed = message?.trim();

  if (!trimmed) {
    return res.status(400).json({ error: "Reply message is required" });
  }

  const comment = await prisma.facebookComment.findUnique({
    where: { id },
  });

  if (!comment) {
    return res.status(404).json({ error: "Comment not found" });
  }

  if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    return res
      .status(500)
      .json({ error: "FACEBOOK_PAGE_ACCESS_TOKEN is not configured" });
  }

  await axios.post(
    `https://graph.facebook.com/v21.0/${comment.commentId}/comments`,
    { message: trimmed },
    { params: { access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN } }
  );

  const updated = await prisma.facebookComment.update({
    where: { id: comment.id },
    data: {
      aiReply: trimmed,
      status: "replied",
      repliedAt: new Date(),
    },
  });

  res.json(updated);
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
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid reservation id" });
  }

  const { status, notes } = req.body;

  const reservation = await prisma.reservation.update({
    where: { id },
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
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid knowledge item id" });
  }

  const { category, title, content, isActive } = req.body;
  const item = await prisma.knowledgeItem.update({
    where: { id },
    data: { category, title, content, isActive },
  });
  res.json(item);
});

router.delete("/knowledge/:id", async (req: Request, res: Response) => {
  const id = getParamId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid knowledge item id" });
  }

  await prisma.knowledgeItem.delete({ where: { id } });
  res.json({ success: true });
});

export default router;
