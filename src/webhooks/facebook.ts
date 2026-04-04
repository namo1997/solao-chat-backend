import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { replyEngine } from "../ai/reply-engine";
import axios from "axios";

const router = Router();
const prisma = new PrismaClient();

const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN!;
const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN!;

// ─── Webhook Verification (Facebook ส่ง GET มาตรวจสอบ) ───────────────────────
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Facebook Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─── Webhook Events (Facebook ส่ง POST มาเมื่อมี event) ────────────────────────
router.post("/", async (req: Request, res: Response) => {
  // ตอบ Facebook ก่อนว่าได้รับแล้ว (ต้องตอบภายใน 20 วิ)
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== "page") return;

  for (const entry of body.entry) {
    // ─── Messenger Messages ───────────────────────────────────────────────────
    if (entry.messaging) {
      for (const event of entry.messaging) {
        await handleMessengerEvent(event);
      }
    }

    // ─── Page Feed (Comments) ─────────────────────────────────────────────────
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === "feed" && change.value?.item === "comment") {
          await handleCommentEvent(change.value);
        }
      }
    }
  }
});

// ─── Handle Messenger Message ─────────────────────────────────────────────────
async function handleMessengerEvent(event: any) {
  // ข้ามถ้าไม่ใช่ข้อความ หรือเป็นข้อความที่ page ส่งเอง
  if (!event.message || event.message.is_echo) return;

  const senderId = event.sender.id;
  const messageText = event.message.text;
  const messageMid = event.message.mid;

  if (!messageText) return;

  console.log(`📩 Messenger จาก ${senderId}: ${messageText}`);

  try {
    // หรือสร้างลูกค้าใหม่
    let customer = await prisma.customer.findUnique({
      where: { facebookId: senderId },
    });

    if (!customer) {
      // ดึงชื่อจาก Facebook Profile
      const profile = await getFacebookProfile(senderId);
      customer = await prisma.customer.create({
        data: {
          facebookId: senderId,
          name: profile.name || "ลูกค้า Facebook",
          platform: "facebook",
          profilePic: profile.picture?.data?.url,
        },
      });
    }

    // หา conversation ที่ยังเปิดอยู่ หรือสร้างใหม่
    let conversation = await prisma.conversation.findFirst({
      where: {
        customerId: customer.id,
        status: { in: ["open", "pending"] },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          customerId: customer.id,
          platform: "facebook",
          status: "open",
        },
      });
    }

    // บันทึกข้อความลูกค้า
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "customer",
        content: messageText,
        facebookMid: messageMid,
      },
    });

    // อัปเดต last message
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: messageText,
        lastMessageAt: new Date(),
      },
    });

    // ถ้า AI enabled → ตอบอัตโนมัติ
    if (conversation.isAiEnabled) {
      // ดึง history สำหรับ context
      const history = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
        take: 10, // 10 ข้อความล่าสุด
      });

      const aiReply = await replyEngine.generateReply(messageText, history);

      if (aiReply) {
        // ส่ง reply กลับผ่าน Messenger
        await sendMessengerMessage(senderId, aiReply);

        // บันทึก AI reply
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "ai",
            content: aiReply,
          },
        });

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessage: aiReply,
            lastMessageAt: new Date(),
          },
        });
      }
    }
  } catch (error) {
    console.error("❌ Error handling messenger event:", error);
  }
}

// ─── Handle Facebook Comment ──────────────────────────────────────────────────
async function handleCommentEvent(value: any) {
  const commentId = value.comment_id;
  const postId = value.post_id;
  const senderId = value.sender_id;
  const senderName = value.sender_name || "ผู้ใช้";
  const message = value.message;

  if (!message || !commentId) return;

  console.log(`💬 Comment จาก ${senderName}: ${message}`);

  try {
    // ตรวจว่าคอมเม้นนี้ถูกบันทึกแล้วหรือยัง
    const existing = await prisma.facebookComment.findUnique({
      where: { commentId },
    });
    if (existing) return;

    // บันทึกคอมเม้น
    const comment = await prisma.facebookComment.create({
      data: {
        commentId,
        postId,
        senderId,
        senderName,
        message,
        status: "pending",
      },
    });

    // ไม่ตอบอัตโนมัติ — รอ admin ตอบจาก dashboard
    console.log(`📋 บันทึกคอมเม้นรอ admin ตอบ: ${comment.id}`);
  } catch (error) {
    console.error("❌ Error handling comment:", error);
  }
}

// ─── Facebook API Helpers ─────────────────────────────────────────────────────
async function sendMessengerMessage(recipientId: string, text: string) {
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: "RESPONSE",
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
    }
  );
}

async function replyToComment(commentId: string, message: string) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${commentId}/comments`,
    { message },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
    }
  );
}

async function getFacebookProfile(userId: string) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${userId}`,
      {
        params: {
          fields: "name,picture",
          access_token: PAGE_ACCESS_TOKEN,
        },
      }
    );
    return res.data;
  } catch {
    return { name: "ลูกค้า Facebook" };
  }
}

export default router;
