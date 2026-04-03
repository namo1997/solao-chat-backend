import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── โหลด Knowledge Base ──────────────────────────────────────────────────────
async function loadKnowledgeBase(): Promise<string> {
  // โหลดจาก database ก่อน
  const items = await prisma.knowledgeItem.findMany({
    where: { isActive: true },
    orderBy: { category: "asc" },
  });

  if (items.length > 0) {
    let kb = "";
    const categories = [...new Set(items.map((i) => i.category))];

    for (const cat of categories) {
      const catItems = items.filter((i) => i.category === cat);
      kb += `\n## ${cat.toUpperCase()}\n`;
      for (const item of catItems) {
        kb += `### ${item.title}\n${item.content}\n\n`;
      }
    }
    return kb;
  }

  // Fallback: โหลดจากไฟล์
  const kbPath = path.join(process.cwd(), "..", "knowledge-base");
  let kb = "";

  try {
    const files = fs.readdirSync(kbPath);
    for (const file of files) {
      if (file.endsWith(".md") || file.endsWith(".txt")) {
        kb += fs.readFileSync(path.join(kbPath, file), "utf-8") + "\n\n";
      }
      if (file.endsWith(".json")) {
        const data = JSON.parse(
          fs.readFileSync(path.join(kbPath, file), "utf-8")
        );
        kb += JSON.stringify(data, null, 2) + "\n\n";
      }
    }
  } catch {
    kb = "ไม่มีข้อมูล Knowledge Base";
  }

  return kb;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
async function buildSystemPrompt(): Promise<string> {
  const companyName = process.env.COMPANY_NAME || "ร้านของเรา";
  const knowledgeBase = await loadKnowledgeBase();

  return `คุณคือพนักงานบริการลูกค้าของ "${companyName}" ทาง Facebook

คุณมีหน้าที่:
1. ตอบคำถามลูกค้าด้วยภาษาไทย สุภาพ เป็นมิตร
2. ให้ข้อมูลที่ถูกต้องตามข้อมูลของร้านด้านล่าง
3. ช่วยรับจองโต๊ะ รับออเดอร์ หรือส่งต่อให้ทีมงาน

กฎสำคัญ:
- ตอบเป็นภาษาไทยเสมอ ยกเว้นลูกค้าถามเป็นภาษาอังกฤษ
- ห้ามแต่งข้อมูลที่ไม่มีในข้อมูลร้าน ถ้าไม่รู้ให้บอกว่า "จะประสานทีมงานให้ทราบนะคะ/ครับ"
- ตอบกระชับ ไม่ยาวเกินไป (ไม่เกิน 3 ประโยคต่อตอบ)
- ถ้าลูกค้าต้องการจองโต๊ะ ให้ถามวันที่, เวลา, จำนวนคน, ชื่อ, เบอร์โทร
- ถ้าลูกค้าสั่งอาหาร ให้ถามรายการ, จำนวน, ที่อยู่จัดส่ง (ถ้า delivery)
- ใช้คำลงท้ายว่า "ครับ" หรือ "ค่ะ" ตลอด

ข้อมูลของร้าน:
${knowledgeBase}`;
}

// ─── Reply Engine ─────────────────────────────────────────────────────────────
class ReplyEngine {
  // ตอบข้อความใน Messenger (มี conversation history)
  async generateReply(
    userMessage: string,
    history: Array<{ sender: string; content: string }>
  ): Promise<string | null> {
    try {
      const systemPrompt = await buildSystemPrompt();

      // สร้าง messages array จาก history
      const messages: Anthropic.MessageParam[] = [];

      for (const msg of history.slice(-8)) {
        // 8 ข้อความล่าสุด
        if (msg.sender === "customer") {
          messages.push({ role: "user", content: msg.content });
        } else if (msg.sender === "ai" || msg.sender === "admin") {
          messages.push({ role: "assistant", content: msg.content });
        }
      }

      // ถ้า message ล่าสุดไม่ใช่ user หรือ messages ว่าง
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.role !== "user") {
        messages.push({ role: "user", content: userMessage });
      }

      // ต้องให้ messages สลับ user/assistant
      const validMessages = ensureAlternating(messages);

      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: validMessages,
      });

      const response = await stream.finalMessage();

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && textBlock.type === "text" ? textBlock.text : null;
    } catch (error) {
      console.error("❌ AI Reply Error:", error);
      return "ขออภัยครับ/ค่ะ มีปัญหาทางเทคนิค กรุณาลองใหม่อีกครั้ง 🙏";
    }
  }

  // ตอบคอมเม้น (ไม่มี history)
  async generateCommentReply(
    comment: string,
    senderName: string
  ): Promise<string | null> {
    try {
      const systemPrompt = await buildSystemPrompt();

      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system:
          systemPrompt +
          "\n\nคุณกำลังตอบคอมเม้นใน Facebook ให้ตอบสั้นๆ กระชับ และเชิญชวนให้ทัก inbox หรือโทรมาหากต้องการข้อมูลเพิ่มเติม",
        messages: [
          {
            role: "user",
            content: `ลูกค้าชื่อ ${senderName} คอมเม้นว่า: "${comment}"`,
          },
        ],
      });

      const response = await stream.finalMessage();

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && textBlock.type === "text" ? textBlock.text : null;
    } catch (error) {
      console.error("❌ AI Comment Reply Error:", error);
      return null;
    }
  }
}

// ─── Helper: ทำให้ messages สลับ user/assistant ────────────────────────────────
function ensureAlternating(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      // รวมข้อความที่ role เดียวกัน
      if (typeof last.content === "string" && typeof msg.content === "string") {
        last.content = last.content + "\n" + msg.content;
      }
    } else {
      result.push({ ...msg });
    }
  }

  // ต้องเริ่มด้วย user
  if (result.length > 0 && result[0].role !== "user") {
    result.shift();
  }

  return result;
}

export const replyEngine = new ReplyEngine();
