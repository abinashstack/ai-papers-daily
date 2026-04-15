/**
 * Fetches 4 trending AI papers from HuggingFace Daily Papers,
 * summarizes them in layman terms using Google Gemini,
 * and emails them via Gmail SMTP.
 *
 * Required environment variables:
 *   GEMINI_API_KEY  - Google Gemini API key (from aistudio.google.com)
 *   GMAIL_USER      - Gmail address to send from
 *   GMAIL_APP_PASS  - Gmail App Password (16-char)
 *   TO_EMAIL        - Comma-separated recipient emails
 */

const nodemailer = require("nodemailer");

const HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers";
const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

async function fetchDailyPapers() {
  console.log("Fetching HuggingFace daily papers...");
  const response = await fetch(HF_DAILY_PAPERS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch daily papers: ${response.status}`);
  }
  const papers = await response.json();

  // Sort by upvotes (most popular first) and take top 4
  const sorted = papers
    .filter((p) => p.paper && p.paper.title && p.paper.summary)
    .sort((a, b) => (b.paper.upvotes || 0) - (a.paper.upvotes || 0))
    .slice(0, 4);

  return sorted.map((p) => ({
    title: p.paper.title,
    abstract: p.paper.summary,
    authors: (p.paper.authors || []).map((a) => a.name || a.user || "Unknown").slice(0, 5),
    arxivId: p.paper.id,
    url: `https://arxiv.org/abs/${p.paper.id}`,
    upvotes: p.paper.upvotes || 0,
  }));
}

async function simplifyWithGemini(paper) {
  const apiKey = process.env.GEMINI_API_KEY;

  const prompt = `You are explaining an AI research paper to someone with no technical background. 
Read this paper title and abstract, then provide:

1. **Simple Title**: Rewrite the title in plain English (max 10 words)
2. **What they did**: 2-3 sentences explaining what the researchers built or discovered. Use everyday analogies. No jargon.
3. **Why it matters**: 1-2 sentences on why a normal person should care about this.
4. **Key takeaway**: One sentence a 15-year-old would understand.

Paper Title: ${paper.title}

Abstract: ${paper.abstract}

Respond in this exact format (keep it concise):
SIMPLE_TITLE: ...
WHAT_THEY_DID: ...
WHY_IT_MATTERS: ...
KEY_TAKEAWAY: ...`;

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const text =
    result.candidates?.[0]?.content?.parts?.[0]?.text || "Summary unavailable";

  // Parse the structured response
  const simpleTitle =
    text.match(/SIMPLE_TITLE:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || paper.title;
  const whatTheyDid =
    text.match(/WHAT_THEY_DID:\s*([\s\S]*?)(?=WHY_IT_MATTERS:|$)/)?.[1]?.trim() ||
    "Summary unavailable.";
  const whyItMatters =
    text.match(/WHY_IT_MATTERS:\s*([\s\S]*?)(?=KEY_TAKEAWAY:|$)/)?.[1]?.trim() ||
    "";
  const keyTakeaway =
    text.match(/KEY_TAKEAWAY:\s*([\s\S]*?)$/)?.[1]?.trim() || "";

  return { simpleTitle, whatTheyDid, whyItMatters, keyTakeaway };
}

function buildEmailHtml(papers) {
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  const paperCards = papers
    .map(
      (p, i) => `
  <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 10px; padding: 22px; margin-bottom: 22px;">
    <div style="font-size: 11px; color: #7c3aed; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Paper ${i + 1} of 4</div>
    <h2 style="font-size: 18px; margin: 0 0 4px; color: #1a1a2e;">
      <a href="${p.url}" style="color: #1a1a2e; text-decoration: none;">${p.summary.simpleTitle}</a>
    </h2>
    <div style="font-size: 12px; color: #999; margin-bottom: 12px;">
      ${p.authors.join(", ")}${p.authors.length > 0 ? " &middot; " : ""}${p.upvotes} upvotes on HuggingFace
    </div>
    
    <div style="margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 4px;">What they did</div>
      <div style="font-size: 15px; line-height: 1.6; color: #444;">${p.summary.whatTheyDid}</div>
    </div>
    
    <div style="margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 4px;">Why it matters</div>
      <div style="font-size: 15px; line-height: 1.6; color: #444;">${p.summary.whyItMatters}</div>
    </div>
    
    <div style="background: #f5f3ff; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 2px;">Key takeaway</div>
      <div style="font-size: 15px; color: #333; font-style: italic;">${p.summary.keyTakeaway}</div>
    </div>
    
    <details style="margin-top: 10px;">
      <summary style="font-size: 12px; color: #888; cursor: pointer;">Original title &amp; abstract</summary>
      <div style="font-size: 12px; color: #666; margin-top: 8px; line-height: 1.5;">
        <strong>${p.title}</strong><br><br>${p.abstract.slice(0, 500)}${p.abstract.length > 500 ? "..." : ""}
      </div>
    </details>
    
    <a href="${p.url}" style="display: inline-block; margin-top: 12px; padding: 8px 16px; background: #7c3aed; color: #fff !important; text-decoration: none; border-radius: 4px; font-size: 13px;">Read Full Paper</a>
  </div>`
    )
    .join("\n");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 620px; margin: 0 auto; padding: 20px; color: #333; background: #fafafa;">
  <div style="border-bottom: 3px solid #7c3aed; padding-bottom: 14px; margin-bottom: 24px;">
    <h1 style="font-size: 24px; margin: 0; color: #1a1a2e;">AI Papers Daily</h1>
    <p style="margin: 4px 0 0; color: #666; font-size: 14px;">${today} &mdash; Top 4 papers, explained simply</p>
  </div>
  ${paperCards}
  <div style="text-align: center; font-size: 12px; color: #999; margin-top: 30px; padding-top: 16px; border-top: 1px solid #eee;">
    <p>Papers sourced from <a href="https://huggingface.co/papers" style="color: #7c3aed;">HuggingFace Daily Papers</a> (ranked by community upvotes)</p>
    <p>Summaries generated by Gemini AI for easy reading</p>
  </div>
</body>
</html>`;
}

async function sendEmail(html, papers) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPass = process.env.GMAIL_APP_PASS;
  const toEmail = process.env.TO_EMAIL;

  if (!gmailUser) throw new Error("GMAIL_USER is required");
  if (!gmailAppPass) throw new Error("GMAIL_APP_PASS is required");
  if (!toEmail) throw new Error("TO_EMAIL is required");

  const recipients = toEmail.split(",").map((e) => e.trim());
  const topPaper = papers[0]?.summary?.simpleTitle || "Today's AI Research";
  const subject = `AI Papers Daily: ${topPaper} + 3 more`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailAppPass },
  });

  const info = await transporter.sendMail({
    from: `"AI Papers Daily" <${gmailUser}>`,
    to: recipients.join(", "),
    subject,
    html,
  });

  console.log("Email sent! Message ID:", info.messageId);
  return info;
}

async function main() {
  const papers = await fetchDailyPapers();
  console.log(`Found ${papers.length} papers:`);
  papers.forEach((p) => console.log(`  - "${p.title}" (${p.upvotes} upvotes)`));

  console.log("\nSimplifying with Gemini...");
  for (const paper of papers) {
    console.log(`  Summarizing: ${paper.title.slice(0, 60)}...`);
    paper.summary = await simplifyWithGemini(paper);
    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\nBuilding email...");
  const html = buildEmailHtml(papers);

  console.log("Sending email...");
  await sendEmail(html, papers);
  console.log("Done!");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
