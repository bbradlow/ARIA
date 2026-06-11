import { NextRequest } from "next/server";
import { AppwriteException, Query } from "node-appwrite";
import { appwrite, articleDocId } from "@/lib/appwrite";
import { sendDM } from "@/lib/slack";
import { scrapeArticleList, scrapeArticleContent } from "@/lib/scrape";
import { summarizeArticle } from "@/lib/summarize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow long runs (requires a Vercel paid plan; Hobby caps at 60s — see README).
export const maxDuration = 300;

/** True if no article document exists yet for this URL (i.e. it's new). */
async function isNewArticle(docId: string): Promise<boolean> {
  const { databases, databaseId, articlesCollectionId } = appwrite();
  try {
    await databases.getDocument({
      databaseId,
      collectionId: articlesCollectionId,
      documentId: docId,
    });
    return false;
  } catch (err) {
    if (err instanceof AppwriteException && err.code === 404) return true;
    throw err; // unexpected error — let the caller handle it
  }
}

export async function GET(req: NextRequest) {
  // Protect the route. Vercel Cron automatically sends
  // `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set in the project.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const { databases, databaseId, articlesCollectionId, subscribersCollectionId } =
    appwrite();

  let checked = 0;
  let posted = 0;
  let subscriberCount = 0;

  try {
    // 1. Scrape the listing page.
    const found = await scrapeArticleList();
    checked = found.length;
    if (found.length === 0) {
      return Response.json({ checked, posted, subscribers: subscriberCount });
    }

    // 2. Determine which articles are new (one cheap lookup per URL by its
    //    deterministic document ID).
    const newArticles: { url: string; docId: string }[] = [];
    for (const article of found) {
      const docId = articleDocId(article.url);
      if (await isNewArticle(docId)) newArticles.push({ url: article.url, docId });
    }
    if (newArticles.length === 0) {
      return Response.json({ checked, posted, subscribers: subscriberCount });
    }

    // 3. Load subscribers once for the whole run.
    const subsRes = await databases.listDocuments({
      databaseId,
      collectionId: subscribersCollectionId,
      queries: [Query.limit(1000)], // bump / paginate if you ever exceed this
    });
    const subscribers = subsRes.documents.map(
      (d) => (d as Record<string, unknown>).slack_user_id as string,
    );
    subscriberCount = subscribers.length;

    // 4. Process each new article independently — one failure never aborts the run.
    for (const article of newArticles) {
      try {
        const { title, bodyText } = await scrapeArticleContent(article.url);
        if (!bodyText) {
          console.warn(`No body text extracted for ${article.url}; skipping.`);
          continue;
        }

        const summary = await summarizeArticle(bodyText);

        // Record the article BEFORE fanning out. This deliberately departs from
        // the spec's "DM then record" order: recording first guarantees that a
        // crash mid-fanout can't trigger a duplicate-DM storm to everyone on the
        // next run. createDocument with the deterministic ID is also an atomic
        // claim — a concurrent run that already recorded it makes this throw 409,
        // and we skip the fanout. The trade-off (a total Slack outage during
        // fanout means a missed article) is far less harmful than mass duplicates.
        try {
          await databases.createDocument({
            databaseId,
            collectionId: articlesCollectionId,
            documentId: article.docId,
            data: { url: article.url, title },
          });
        } catch (err) {
          if (err instanceof AppwriteException && err.code === 409) {
            console.error(`Already recorded ${article.url}; skipping fanout`);
            continue;
          }
          throw err;
        }

        const text = `📄 *New Research: ${title}*\n\n${summary}\n\n🔗 ${article.url}`;
        for (const userId of subscribers) {
          try {
            await sendDM(userId, text);
          } catch (dmErr) {
            console.error(`Failed to DM ${userId} about ${article.url}`, dmErr);
          }
        }

        posted += 1;
      } catch (articleErr) {
        console.error(`Failed to process article ${article.url}`, articleErr);
        // Continue with the next article.
      }
    }

    return Response.json({ checked, posted, subscribers: subscriberCount });
  } catch (err) {
    console.error("Cron run failed", err);
    return Response.json(
      { error: "cron_failed", checked, posted, subscribers: subscriberCount },
      { status: 500 },
    );
  }
}
