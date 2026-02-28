export interface Env {
  MONITOR_KV: KVNamespace;
  TARGET_URL: string;
  DISCORD_WEBHOOK_URL: string;
  LLM_API_KEY: string;
  LLM_API_URL: string;
}

export default {
  // Cron 定時任務進入點
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkTask(env));
  },

  // HTTP 進入點 (讓你可以手動打開網址測試)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // 【方案二測試開關】：如果網址後面加上 ?test=true，就直接發送測試推播
    if (url.searchParams.get("test") === "true") {
      await sendDiscordNotification(
        "Old-Test-Build-123", 
        "New-Test-Build-456", 
        "這是一條測試訊息！如果你看到這段話，代表 Discord Webhook 串接完全成功囉 🚀", 
        env
      );
      return new Response("✅ 測試通知已成功發送至 Discord！請檢查你的頻道。");
    }

    // 正常的執行邏輯 (手動觸發監控)
    await checkTask(env);
    return new Response("✅ 監控任務執行完畢！請查看 Discord 或 KV 狀態。");
  },
};

// ================= 核心函式 =================

async function checkTask(env: Env) {
  try {
    const { buildId, scriptPaths } = await fetchPageData(env.TARGET_URL);
    if (!buildId) return;

    // 取得當前的 JS 內容 (去除 Hash)
    const currentJsFiles = await fetchJsContents(env.TARGET_URL, scriptPaths);

    // 從 Cloudflare KV 讀取上一次的紀錄
    const lastBuildId = await env.MONITOR_KV.get('LAST_BUILD_ID');
    const lastJsFilesStr = await env.MONITOR_KV.get('LAST_JS_FILES');
    const lastJsFiles: Record<string, string> = lastJsFilesStr ? JSON.parse(lastJsFilesStr) : {};

    // 第一次啟動，初始化資料但不通知
    if (!lastBuildId) {
      console.log(`🚀 監控啟動完成，首次寫入 BuildID: ${buildId}`);
      await env.MONITOR_KV.put('LAST_BUILD_ID', buildId);
      await env.MONITOR_KV.put('LAST_JS_FILES', JSON.stringify(currentJsFiles));
      return;
    }

    // 發現版本更新
    if (buildId !== lastBuildId) {
      console.log(`\n⚠️ 發現版本更新！ ${lastBuildId} -> ${buildId}`);

      // 1. 內建輕量化比對，產生關鍵字 Diff
      const diffText = generateDiff(lastJsFiles, currentJsFiles);
      console.log("產生的 Diff 片段:", diffText);

      // 2. 呼叫 AI 產生簡報
      console.log("🤖 正在呼叫 AI 產生簡報...");
      const summary = await getAIPatchSummary(diffText, env);

      // 3. 發送 Discord 通知
      await sendDiscordNotification(lastBuildId, buildId, summary, env);

      // 4. 更新 KV 狀態
      await env.MONITOR_KV.put('LAST_BUILD_ID', buildId);
      await env.MONITOR_KV.put('LAST_JS_FILES', JSON.stringify(currentJsFiles));
    } else {
      console.log(`[${new Date().toISOString()}] 無更新，當前版本: ${buildId}`);
    }
  } catch (error) {
    console.error("❌ 執行檢查時發生錯誤:", error);
  }
}

/**
 * 請求網頁並解析出 BuildID 與 JS 路徑
 */
async function fetchPageData(targetUrl: string) {
  const res = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MonitorBot/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  const html = await res.text();

  const buildIdMatch = html.match(/"buildId":"([^"]+)"/);
  const buildId = buildIdMatch ? buildIdMatch[1] : null;

  const scriptRegex = /src="(\/_next\/static\/chunks\/[^"]+\.js)"/g;
  const scriptPaths = [...html.matchAll(scriptRegex)].map(m => m[1]);

  return { html, buildId, scriptPaths };
}

/**
 * 下載 JS 並提取基底檔名 (去除 Hash 以利精準對比)
 */
async function fetchJsContents(targetUrl: string, scriptPaths: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const origin = new URL(targetUrl).origin;

  await Promise.all(
    scriptPaths.map(async (path) => {
      try {
        const res = await fetch(`${origin}${path}`);
        const content = await res.text();
        // 將 page-f771e2c1298902e1.js 轉成 page.js
        const baseName = path.replace(/-[a-f0-9]{16,}\.js$/, '.js');
        files[baseName] = content;
      } catch (e) {
        console.error(`無法下載腳本 ${path}:`, e);
      }
    })
  );
  return files;
}

/**
 * [無依賴版本] 簡易 Token 比對：提取新增與移除的關鍵字、變數名稱
 */
function generateDiff(oldFiles: Record<string, string>, newFiles: Record<string, string>): string {
  let diffSummary = "";
  // 匹配英數字、底線、引號內的字串、中文字 (過濾掉符號)
  const tokenize = (str: string) => new Set(str.split(/[^a-zA-Z0-9_'"\u4e00-\u9fa5]+/));

  for (const [path, newContent] of Object.entries(newFiles)) {
    const oldContent = oldFiles[path];
    if (!oldContent) {
      diffSummary += `\n[新增模組] ${path}\n`;
      continue;
    }

    if (oldContent !== newContent) {
      const oldTokens = tokenize(oldContent);
      const newTokens = tokenize(newContent);

      // 找出長度大於 3 的有意義關鍵字
      const added = [...newTokens].filter(x => !oldTokens.has(x) && x.length > 3);
      const removed = [...oldTokens].filter(x => !newTokens.has(x) && x.length > 3);

      if (added.length > 0 || removed.length > 0) {
        diffSummary += `\n--- 模組變更: ${path} ---\n`;
        if (added.length > 0) diffSummary += `[新增關鍵字/字串]: ${added.slice(0, 40).join(", ")}\n`;
        if (removed.length > 0) diffSummary += `[移除關鍵字/字串]: ${removed.slice(0, 40).join(", ")}\n`;
      }
    }
  }
  return diffSummary.substring(0, 3000); 
}

/**
 * 呼叫 LLM 總結
 */
async function getAIPatchSummary(diffText: string, env: Env): Promise<string> {
  if (!diffText.trim()) return "僅有微小變更或資源檔更新，無明顯業務邏輯變化。";

  const prompt = `你是一個資深前端工程師。目標網站剛剛更新了，以下是 JS 代碼變更時提取出的「新增/移除」關鍵字與字串。
請透過這些蛛絲馬跡，推測並用「一句話（不超過30字）」總結工程師可能更新了什麼業務邏輯。
例如：「增加歐盟國家判斷，調整初始化邏輯以符合地區合規要求」。

變更內容：
${diffText}`;

  try {
    const res = await fetch(env.LLM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat", // 根據你的 API 供應商填寫模型名稱 (如 gpt-4o-mini 或 deepseek-chat)
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });

    const data: any = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "無法解析更新內容。";
  } catch (error) {
    console.error("AI 總結失敗:", error);
    return "AI 簡報生成失敗，請手動查看變更。";
  }
}

/**
 * 發送 Discord Embed 通知
 */
async function sendDiscordNotification(oldId: string, newId: string, summary: string, env: Env) {
  const payload = {
    content: "📡 **官網測試主頁 (www-test) 發布了新版本！**",
    embeds: [
      {
        title: "🔄 系統更新簡報",
        description: `> ${summary}`,
        color: 3447003,
        fields: [
          { name: "BuildID 變更", value: `\`${oldId}\` ➔ \`${newId}\``, inline: false }
        ],
        footer: { text: "監控室小豬為您報導 🐷" },
        timestamp: new Date().toISOString()
      }
    ]
  };

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
