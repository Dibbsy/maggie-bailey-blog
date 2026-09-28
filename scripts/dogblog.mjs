#!/usr/bin/env node
/**
 * Maggie & Bailey's blog robot.
 *
 *   node scripts/dogblog.mjs publish   Publish ONE post: the next pre-written post in
 *                                      dogblog/queue/, or if the queue is empty, write a
 *                                      fresh post from the oldest photo in dogblog/inbox/.
 *   node scripts/dogblog.mjs draft     Turn photos in dogblog/inbox/ into posts in
 *                                      dogblog/queue/ so you can read/edit them first.
 *        --count N                     (draft only) how many photos to process (default: all)
 *        --dry-run                     Don't call the API or change files; show what would happen.
 *
 * Writing new posts needs ANTHROPIC_API_KEY. Optional: CLAUDE_MODEL (default claude-sonnet-5).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INBOX = path.join(ROOT, "dogblog/inbox");
const QUEUE = path.join(ROOT, "dogblog/queue");
const PERSONA = path.join(ROOT, "dogblog/persona.md");
const POSTS = path.join(ROOT, "src/content/blog");
const PHOTOS = path.join(ROOT, "public/photos");
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]);
const AUTHORS = ["maggie", "bailey", "both"];
const TZ = "Australia/Sydney";

const args = process.argv.slice(2);
const cmd = args[0];
const DRY = args.includes("--dry-run");
const countArg = args.indexOf("--count");
const COUNT = countArg > -1 ? Number(args[countArg + 1]) : Infinity;

// ---------- helpers ----------
const log = (...m) => console.log("🐾", ...m);

function sydneyDate(d = new Date()) {
  // YYYY-MM-DD in Sydney time
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}-${i}${ext}`);
  return p;
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .filter(filter)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Minimal frontmatter reader: one `key: value` per line; values may be "double", 'single' or unquoted. */
function parseFrontmatter(src) {
  const data = {};
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) {
      try { v = JSON.parse(v.slice(0, v.lastIndexOf('"') + 1)); } catch { v = v.replace(/^"|"$/g, ""); }
    } else if (v.startsWith("'")) {
      v = v.slice(1, v.lastIndexOf("'")).replace(/''/g, "'");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    data[m[1]] = v;
  }
  return data;
}

function parseMd(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path.basename(file)} has no frontmatter`);
  return { data: parseFrontmatter(m[1]), body: m[2].trim() };
}

function writeMd(file, data, body) {
  const fm = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n\n${body.trim()}\n`);
}

/** Convert HEIC etc. to a web-ready JPEG, auto-rotated, EXIF/GPS stripped. */
async function toJpeg(src, dest, maxSize = 1600) {
  let input = src;
  let tmp;
  if (/\.hei[cf]$/i.test(src)) {
    tmp = path.join(os.tmpdir(), `dogblog-${Date.now()}.jpg`);
    try {
      if (process.platform === "darwin") execFileSync("sips", ["-s", "format", "jpeg", src, "--out", tmp], { stdio: "ignore" });
      else execFileSync("heif-convert", ["-q", "92", src, tmp], { stdio: "ignore" });
    } catch {
      throw new Error(`Couldn't convert ${path.basename(src)} from HEIC. On Linux: sudo apt-get install libheif-examples`);
    }
    input = tmp;
  }
  const buf = await sharp(input)
    .rotate() // respect iPhone orientation
    .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true }) // metadata (incl. GPS) is dropped by default
    .toBuffer();
  if (tmp) fs.rmSync(tmp, { force: true });
  if (dest) fs.writeFileSync(dest, buf);
  return buf;
}

function existingPosts() {
  const fromDir = (dir) =>
    listFiles(dir, (f) => /\.mdx?$/.test(f)).map((f) => {
      const { data } = parseMd(path.join(dir, f));
      return { file: f, title: data.title, author: data.author, pubDate: data.pubDate };
    });
  const published = fromDir(POSTS).sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
  return [...published, ...fromDir(QUEUE)];
}

function nextAuthor(posts) {
  // Rotate Maggie -> Bailey -> both so everyone gets a turn.
  const last = [...posts].reverse().find((p) => AUTHORS.includes(p.author))?.author;
  return AUTHORS[(AUTHORS.indexOf(last) + 1) % AUTHORS.length] ?? "maggie";
}

// ---------- the writer ----------
async function writePostFromPhoto(photoPath, { author, recentTitles }) {
  const notePath = photoPath.replace(/\.[^.]+$/, ".txt");
  const note = fs.existsSync(notePath) ? fs.readFileSync(notePath, "utf8").trim() : "";
  const persona = fs.readFileSync(PERSONA, "utf8");
  const today = new Date().toLocaleDateString("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const system = `You write blog posts for "Maggie & Bailey", a blog written from the point of view of two dogs about life with their humans, Mum and Dad.

${persona}

Writing rules:
- Write in first person as the dog(s) named as author. If the author is "both", Maggie and Bailey share the post (for example, taking turns or interrupting each other, with clear "MAGGIE:" / "BAILEY:" style handovers or short sections).
- Warm, funny, a little bit silly, and affectionate towards Mum and Dad. Dog logic is encouraged.
- The photo is the heart of the post. Describe and react to what's actually in it. Don't invent things that contradict it.
- If you can't tell from the photo (or note) which dog is which, don't claim a specific dog is doing something. Keep it general or use "both".
- Around 200 to 350 words. Short paragraphs. Markdown is fine; no headings at the top (the title is shown separately).
- Australian English spelling.
- Don't repeat the ideas behind these recent post titles: ${recentTitles.length ? recentTitles.map((t) => `"${t}"`).join(", ") : "(none yet)"}.

Reply with ONLY a JSON object, no code fences:
{"title": "...", "description": "one-sentence teaser, under 160 characters", "heroAlt": "plain description of the photo for screen readers", "author": "maggie|bailey|both", "body": "markdown post body"}`;

  const userText = [
    `Today is ${today}.`,
    `Author for this post: ${author} (you may switch to another author only if the photo clearly only shows the other dog).`,
    note ? `Note from Dad about this photo: ${note}` : "No note from Dad about this photo.",
    "Write the post.",
  ].join("\n");

  if (DRY) {
    log(`[dry-run] would send ${path.basename(photoPath)} to Claude as ${author}`);
    return { title: `Dry run: ${path.basename(photoPath)}`, description: "Dry run", heroAlt: "", author, body: "_(dry run)_" };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set, so I can't write a new post from a photo.");

  const small = await toJpeg(photoPath, null, 1024);
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 2000,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } },
            { type: "text", text: userText },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const post = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!post.title || !post.body) throw new Error("Claude's reply was missing a title or body:\n" + text);
  if (!AUTHORS.includes(post.author)) post.author = author;
  return { ...post, notePath };
}

function removeOriginal(photoPath, notePath) {
  if (DRY) return;
  fs.rmSync(photoPath, { force: true });
  if (notePath) fs.rmSync(notePath, { force: true });
}

// ---------- commands ----------
async function publishFromQueue() {
  const next = listFiles(QUEUE, (f) => /\.mdx?$/.test(f))[0];
  if (!next) return false;
  const file = path.join(QUEUE, next);
  const { data, body } = parseMd(file);
  const date = sydneyDate();
  const slug = slugify(next.replace(/\.mdx?$/, "").replace(/^\d+[-_ ]*/, "") || data.title);
  const out = uniquePath(POSTS, `${date}-${slug}`, ".md");
  const base = path.basename(out, ".md");

  let heroImage = data.heroImage;
  if (data.photo) {
    const src = path.join(QUEUE, data.photo);
    if (!fs.existsSync(src)) throw new Error(`${next} says photo: ${data.photo}, but that file isn't in dogblog/queue/`);
    heroImage = `/photos/${base}.jpg`;
    if (!DRY) {
      await toJpeg(src, path.join(PHOTOS, `${base}.jpg`));
      fs.rmSync(src);
    }
  }
  const { photo, pubDate, ...rest } = data;
  if (!DRY) {
    writeMd(out, { ...rest, author: rest.author ?? "both", pubDate: new Date().toISOString(), heroImage }, body);
    fs.rmSync(file);
  }
  log(`Published from queue: "${data.title}" -> src/content/blog/${path.basename(out)}`);
  return data.title;
}

async function publishFromInbox() {
  const photo = listFiles(INBOX, (f) => PHOTO_EXT.has(path.extname(f).toLowerCase()))[0];
  if (!photo) return false;
  const photoPath = path.join(INBOX, photo);
  const posts = existingPosts();
  const post = await writePostFromPhoto(photoPath, {
    author: nextAuthor(posts),
    recentTitles: posts.slice(-12).map((p) => p.title),
  });
  const date = sydneyDate();
  const out = uniquePath(POSTS, `${date}-${slugify(post.title)}`, ".md");
  const base = path.basename(out, ".md");
  if (!DRY) {
    await toJpeg(photoPath, path.join(PHOTOS, `${base}.jpg`));
    writeMd(
      out,
      {
        title: post.title,
        description: post.description,
        author: post.author,
        pubDate: new Date().toISOString(),
        heroImage: `/photos/${base}.jpg`,
        heroAlt: post.heroAlt,
      },
      post.body,
    );
  }
  removeOriginal(photoPath, post.notePath);
  log(`Wrote and published "${post.title}" (${post.author}) from ${photo}`);
  return post.title;
}

async function draft() {
  const photos = listFiles(INBOX, (f) => PHOTO_EXT.has(path.extname(f).toLowerCase())).slice(0, COUNT);
  if (!photos.length) return log("No photos in dogblog/inbox/. Add some and try again.");
  const existingNums = listFiles(QUEUE, (f) => /^\d+/.test(f)).map((f) => parseInt(f, 10));
  let n = existingNums.length ? Math.max(...existingNums) + 1 : 1;
  for (const photo of photos) {
    const photoPath = path.join(INBOX, photo);
    const posts = existingPosts();
    const post = await writePostFromPhoto(photoPath, {
      author: nextAuthor(posts),
      recentTitles: posts.slice(-12).map((p) => p.title),
    });
    const base = `${String(n++).padStart(2, "0")}-${slugify(post.title)}`;
    if (!DRY) {
      await toJpeg(photoPath, path.join(QUEUE, `${base}.jpg`));
      writeMd(
        path.join(QUEUE, `${base}.md`),
        { title: post.title, description: post.description, author: post.author, photo: `${base}.jpg`, heroAlt: post.heroAlt },
        post.body,
      );
    }
    removeOriginal(photoPath, post.notePath);
    log(`Drafted ${base}.md (${post.author}) from ${photo}`);
  }
  log("Done. Read and edit the posts in dogblog/queue/, then commit and push.");
}

async function main() {
  fs.mkdirSync(POSTS, { recursive: true });
  fs.mkdirSync(PHOTOS, { recursive: true });
  if (cmd === "publish") {
    const title = (await publishFromQueue()) || (await publishFromInbox());
    if (!title) log("Nothing to publish: the queue and the photo inbox are both empty.");
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title ? String(title).replace(/\n/g, " ") : ""}\n`);
    }
  } else if (cmd === "draft") {
    await draft();
  } else {
    console.log("Usage: node scripts/dogblog.mjs publish|draft [--count N] [--dry-run]");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
