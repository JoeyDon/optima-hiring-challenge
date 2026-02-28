/**
 * 面试题 Task 2：找出 Bug
 * ========================
 * 这是一个简化版的企微自动回复机器人。
 * 上线后用户反馈：「有时候机器人会重复回复同一条消息」
 *
 * 请用 AI 辅助排查问题原因，写出：
 *   1. 你找到了哪些可能导致重复回复的 Bug？（可能不止一个）
 *   2. 每个 Bug 的修复方案
 *   3. 你的排查过程（用了什么工具、问了 AI 什么问题）
 *
 * 提示：这段代码里至少有 3 个会导致重复回复的问题。
 */

const http = require("http");

// ─── 配置 ──────────────────────────────────────────
const API_URL = process.env.API_URL || "https://flowbot.example.com";
const ROBOT_ID = process.env.ROBOT_ID || "test-robot-123";
const AI_API_URL = process.env.AI_API_URL || "https://api.example.com/v1";
const AI_API_KEY = process.env.AI_API_KEY || "";
const PORT = 9004;

// ─── 状态 ──────────────────────────────────────────
const chatMemory = {};        // friendName -> [{role, content}]
const processedMessages = []; // 已处理消息列表（用于去重）
const DEBOUNCE_MS = 3000;     // 攒批等待时间
const pendingBatches = {};    // friendName -> { texts, timer }

// ─── AI 调用 ────────────────────────────────────────
async function callAI(messages) {
  const res = await fetch(`${AI_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gemini-2.5-pro",
      messages,
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "抱歉，请稍后再试。";
}

// ─── 发送消息到微信 ──────────────────────────────────
async function sendReply(friendName, message) {
  const url = `${API_URL}/api/sendTask?robotId=${ROBOT_ID}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskList: [{ type: 10001, searchText: friendName, message }],
    }),
  });
  console.log(`[Bot] → "${friendName}": ${message.slice(0, 50)}`);
}

// ─── 处理回调消息 ────────────────────────────────────
async function handleCallback(body) {
  const { searchText: friendName, data: messages, mode } = body;

  if (mode === "online" || mode === "offline") return;
  if (mode !== "logs") return;

  // 过滤出用户消息
  const newTexts = [];
  for (const msg of messages) {
    if (msg.type !== "text") continue;
    const text = (msg.data?.message || "").trim();
    if (!text) continue;

    // 去重：检查是否已处理过
    if (processedMessages.includes(text)) continue;
    processedMessages.push(text);

    newTexts.push(text);
  }

  if (newTexts.length === 0) return;

  console.log(`[Bot] ← "${friendName}": ${newTexts.length} new msg(s)`);

  // 攒批：3 秒内的消息合并处理
  if (pendingBatches[friendName]) {
    pendingBatches[friendName].texts.push(...newTexts);
  } else {
    pendingBatches[friendName] = { texts: [...newTexts], timer: null };
  }

  pendingBatches[friendName].timer = setTimeout(async () => {
    const batch = pendingBatches[friendName];
    delete pendingBatches[friendName];

    const combined = batch.texts.join("\n");
    const chatId = friendName;

    // 记忆管理
    if (!chatMemory[chatId]) chatMemory[chatId] = [];
    chatMemory[chatId].push({ role: "user", content: combined });

    // 调用 AI
    const aiMessages = [
      { role: "system", content: "你是一个友好的助手，用中文简洁回复。" },
      ...chatMemory[chatId].slice(-10),
    ];

    const reply = await callAI(aiMessages);
    chatMemory[chatId].push({ role: "assistant", content: reply });

    // 发送回复
    await sendReply(friendName, reply);
  }, DEBOUNCE_MS);
}

// ─── HTTP 服务器 ────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const json = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 200, message: "ok" }));
        await handleCallback(json);
      } catch (e) {
        console.error("[Bot] Error:", e.message);
        res.writeHead(200);
        res.end(JSON.stringify({ code: 200 }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => console.log(`[Bot] Listening on port ${PORT}`));
