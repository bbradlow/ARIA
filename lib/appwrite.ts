import { Client, Databases } from "node-appwrite";
import { createHash } from "crypto";

let databases: Databases | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

/**
 * Lazily-initialized Appwrite Databases service, authenticated with a
 * server API key. Server-side only — the API key must never reach the browser.
 */
export function getDatabases(): Databases {
  if (databases) return databases;

  const client = new Client()
    .setEndpoint(requireEnv("APPWRITE_ENDPOINT")) // e.g. https://nyc.cloud.appwrite.io/v1
    .setProject(requireEnv("APPWRITE_PROJECT_ID"))
    .setKey(requireEnv("APPWRITE_API_KEY"));

  databases = new Databases(client);
  return databases;
}

/** Bundles the Databases service with the configured database/collection IDs. */
export function appwrite() {
  return {
    databases: getDatabases(),
    databaseId: requireEnv("APPWRITE_DATABASE_ID"),
    articlesCollectionId: requireEnv("APPWRITE_ARTICLES_COLLECTION_ID"),
    subscribersCollectionId: requireEnv("APPWRITE_SUBSCRIBERS_COLLECTION_ID"),
  };
}

/**
 * Deterministic Appwrite document ID for an article URL.
 *
 * Appwrite document IDs must be <=36 chars, only [a-zA-Z0-9._-], and can't start
 * with a special char — so a URL can't be an ID directly. We hash the URL and
 * prefix a letter. Because the ID is deterministic, `createDocument` doubles as
 * an atomic "claim": a second attempt for the same URL fails with a 409, which
 * is exactly the dedup guarantee we want (no unique index required).
 */
export function articleDocId(url: string): string {
  return "a" + createHash("sha256").update(url).digest("hex").slice(0, 31);
}
