/**
 * Fetches 4 trending AI papers from HuggingFace Daily Papers,
 * downloads the full paper HTML from arXiv, summarizes them in
 * layman terms using OpenAI GPT-4o-mini, and emails via Gmail SMTP.
 *
 * Required environment variables:
 *   OPENAI_API_KEY  - OpenAI API key
 *   GMAIL_USER      - Gmail address to send from
 *   GMAIL_APP_PASS  - Gmail App Password (16-char)
 *   TO_EMAIL        - Comma-separated recipient emails
 */

const nodemailer = require("nodemailer");

const HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

async function fetchDailyPapers() {
  console.log("Fetching HuggingFace daily papers...");
  const response = await fetch(HF_DAILY_PAPERS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch daily papers: ${response.status}`);
  }
  const papers = await response.json();

  const sorted = papers
    .filter((p) => p.paper && p.paper.title && p.paper.summary)
    .sort((a, b) => (b.paper.upvotes || 0) - (a.paper.upvotes || 0))
    .slice(0, 4);

  return sorted.map((p) => ({
    title: p.paper.title,
    abstract: p.paper.summary,
    authors: (p.paper.authors || [])
      .map((a) => a.name || a.user || "Unknown")
      .slice(0, 5),
    arxivId: p.paper.id,
    url: `https://arxiv.org/abs/${p.paper.id}`,
    htmlUrl: `https://arxiv.org/html/${p.paper.id}`,
    upvotes: p.paper.upvotes || 0,
  }));
}

async function fetchFullPaperText(paper) {
  console.log(`  Fetching full text: ${paper.arxivId}...`);
  try {
    const response = await fetch(paper.htmlUrl, {
      headers: { "User-Agent": "AI-Papers-Daily-Bot/1.0" },
    });

    if (!response.ok) {
      console.log(`    HTML not available (${response.status}), using abstract only.`);
      return null;
    }

    const html = await response.text();

    // Extract text content from the HTML, stripping tags
    // Focus on main article content, skip references/bibliography
    let text = html
      // Remove script/style tags and their content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // Remove references/bibliography section
      .replace(/<section[^>]*class="[^"]*bib[^"]*"[\s\S]*?<\/section>/gi, "")
      // Remove all HTML tags
      .replace(/<[^>]+>/g, " ")
      // Clean up whitespace
      .replace(/\s+/g, " ")
      .trim();

    // Truncate to ~12000 chars (~3000 tokens) to keep costs reasonable
    // This covers intro, methods, results, and conclusion for most papers
    if (text.length > 12000) {
      text = text.slice(0, 12000) + "... [truncated]";
    }

    if (text.length < 200) {
      console.log("    Full text too short, using abstract only.");
      return null;
    }

    console.log(`    Got ${text.length} chars of full text.`);
    return text;
  } catch (err) {
    console.log(`    Error fetching full text: ${err.message}`);
    return null;
  }
}

async function simplifyWithOpenAI(paper, fullText) {
  const apiKey = process.env.OPENAI_API_KEY;

  const sourceText = fullText
    ? `Full Paper Text (truncated):\n${fullText}`
    : `Abstract:\n${paper.abstract}`;

  const sourceNote = fullText
    ? "You have access to the full paper text below."
    : "You only have the abstract. Summarize based on that.";

  const prompt = `You are explaining an AI research paper to a curious person with NO technical background.
${sourceNote}

Read the paper content and provide:

1. **Simple Title**: Rewrite the title in plain English (max 10 words)
2. **What they did**: 3-4 sentences explaining what the researchers built or discovered. Use everyday analogies. Imagine you're explaining to your non-tech friend over coffee. No jargon at all.
3. **The problem they solved**: 2 sentences on what problem existed before this work.
4. **How it works (simply)**: 2-3 sentences using a real-world analogy. E.g. "Think of it like a librarian who..." 
5. **Why it matters**: 2 sentences on real-world impact a normal person would care about.
6. **Key takeaway**: One memorable sentence a 15-year-old would understand and remember.

Paper Title: ${paper.title}

${sourceText}

Respond in this exact format (keep it concise and jargon-free):
SIMPLE_TITLE: ...
WHAT_THEY_DID: ...
PROBLEM_SOLVED: ...
HOW_IT_WORKS: ...
WHY_IT_MATTERS: ...
KEY_TAKEAWAY: ...`;

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.log(`    OpenAI error: ${response.status}, using fallback.`);
    return fallbackSummary(paper);
  }

  const result = await response.json();
  const text = result.choices?.[0]?.message?.content || "";

  if (!text) return fallbackSummary(paper);
  return parseResponse(text, paper.title);
}

function parseResponse(text, fallbackTitle) {
  const simpleTitle =
    text.match(/SIMPLE_TITLE:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || fallbackTitle;
  const whatTheyDid =
    text.match(/WHAT_THEY_DID:\s*([\s\S]*?)(?=PROBLEM_SOLVED:|$)/)?.[1]?.trim() ||
    "Summary unavailable.";
  const problemSolved =
    text.match(/PROBLEM_SOLVED:\s*([\s\S]*?)(?=HOW_IT_WORKS:|$)/)?.[1]?.trim() || "";
  const howItWorks =
    text.match(/HOW_IT_WORKS:\s*([\s\S]*?)(?=WHY_IT_MATTERS:|$)/)?.[1]?.trim() || "";
  const whyItMatters =
    text.match(/WHY_IT_MATTERS:\s*([\s\S]*?)(?=KEY_TAKEAWAY:|$)/)?.[1]?.trim() || "";
  const keyTakeaway =
    text.match(/KEY_TAKEAWAY:\s*([\s\S]*?)$/)?.[1]?.trim() || "";

  return { simpleTitle, whatTheyDid, problemSolved, howItWorks, whyItMatters, keyTakeaway };
}

function fallbackSummary(paper) {
  const abstract = paper.abstract.slice(0, 300).replace(/\n/g, " ");
  return {
    simpleTitle: paper.title,
    whatTheyDid: abstract + "...",
    problemSolved: "",
    howItWorks: "",
    whyItMatters: "Read the full paper for more details.",
    keyTakeaway: "A new AI research contribution worth exploring.",
  };
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
    <div style="font-size: 11px; color: #7c3aed; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Paper ${i + 1} of 4 ${p.readFullPaper ? "&#x1F4D6; Full paper read" : "&#x1F4CB; Abstract only"}</div>
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

    ${p.summary.problemSolved ? `
    <div style="margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 4px;">The problem they solved</div>
      <div style="font-size: 15px; line-height: 1.6; color: #444;">${p.summary.problemSolved}</div>
    </div>` : ""}

    ${p.summary.howItWorks ? `
    <div style="margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 4px;">How it works (simply)</div>
      <div style="font-size: 15px; line-height: 1.6; color: #444;">${p.summary.howItWorks}</div>
    </div>` : ""}
    
    <div style="margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 4px;">Why it matters</div>
      <div style="font-size: 15px; line-height: 1.6; color: #444;">${p.summary.whyItMatters}</div>
    </div>
    
    <div style="background: #f5f3ff; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px;">
      <div style="font-size: 13px; font-weight: 600; color: #7c3aed; margin-bottom: 2px;">Key takeaway</div>
      <div style="font-size: 15px; color: #333; font-style: italic;">${p.summary.keyTakeaway}</div>
    </div>
    
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
    <p>Full papers read and simplified by AI</p>
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

  console.log("\nFetching full paper texts from arXiv...");
  for (const paper of papers) {
    const fullText = await fetchFullPaperText(paper);
    paper.fullText = fullText;
    paper.readFullPaper = !!fullText;
    // Small delay to be polite to arXiv servers
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\nSimplifying with OpenAI...");
  for (const paper of papers) {
    console.log(`  Summarizing: ${paper.title.slice(0, 60)}...`);
    paper.summary = await simplifyWithOpenAI(paper, paper.fullText);
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
