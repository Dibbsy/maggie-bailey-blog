# How the dog blog runs itself

A GitHub Action (`.github/workflows/publish-dog-post.yml`) runs **Mon, Wed and Fri
at 7am Sydney time**. Each run publishes **one** post, then pushes. Cloudflare sees
the push and redeploys the site.

Where each run gets its post:

1. **`dogblog/queue/`**: pre-written posts, published in filename order (`01-…`, `02-…`).
   These are posts you've already read and approved.
2. **`dogblog/inbox/`**: if the queue is empty, the oldest photo here gets turned
   into a brand-new post by Claude and published straight away.
3. If both are empty, nothing happens that day.

## Adding photos from your iPhone

Either:
- **On GitHub (from the phone):** open the repo → `dogblog/inbox` → *Add file* →
  *Upload files* → choose photos → *Commit changes*. HEIC is fine.
- **From the Mac:** AirDrop the photos to the Mac, copy them into `dogblog/inbox/`,
  commit and push.

**Optional note:** add a text file with the same name as the photo
(`IMG_1234.txt` next to `IMG_1234.HEIC`) with anything the photo can't show:
*"Maggie on the left. Beach on Sunday, she stole a kid's ball and got a pat for it."*
Notes make the posts much better.

Photos are resized and have their location data (GPS) stripped before going on the site.
The originals are removed from the inbox once used.

## Reviewing posts before they go live (the "batch")

On the Mac, with photos in the inbox:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run post:draft             # all photos in the inbox → dogblog/queue/
npm run post:draft -- --count 6   # or just the next 6
```

Read and edit the `.md` files in `dogblog/queue/` (change anything, delete ones
you don't like, rename to re-order), then commit and push. They'll go out
one per run.

## Writing a post yourself

Drop a file into `dogblog/queue/`, for example `05-bath-day.md`:

```markdown
---
title: "Bath day: a tragedy in three acts"
description: "Mum got the shampoo out. Bailey hid. Maggie licked the soap."
author: "both"        # maggie | bailey | both
photo: "05-bath-day.jpg"   # optional, a photo in the same folder
---

Your post here…
```

## Making the dogs sound right

Edit `dogblog/persona.md`. Every new post reads it. Adding what each dog looks
like helps Claude tell them apart in photos.

## One-off setup

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   `ANTHROPIC_API_KEY` = your key from console.anthropic.com. (Only needed for
   photo → post. Queued posts publish without it.)
2. Optional: a repository **variable** `CLAUDE_MODEL` to pick a different model.
3. **Settings → Actions → General → Workflow permissions**: *Read and write*.
4. To publish one right now: **Actions → Publish a dog post → Run workflow**.
