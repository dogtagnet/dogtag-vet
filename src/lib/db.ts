import mongoose from "mongoose";
import {requireEnv} from "@/lib/env";

/**
 * Cached Mongo connection, keyed on the Node.js global object so hot-reload in dev (and repeated
 * serverless invocations sharing a warm container) reuse one connection instead of opening a new
 * one per module reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __dogtagVetMongoose: {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
  } | undefined;
}

const cache = globalThis.__dogtagVetMongoose ?? {conn: null, promise: null};
globalThis.__dogtagVetMongoose = cache;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    const uri = requireEnv("MONGODB_URI");
    cache.promise = mongoose.connect(uri, {
      bufferCommands: false,
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (err) {
    // A rejected connect (e.g. the database was briefly down) must NOT stay cached: every later
    // request would re-await the same rejected promise and fail instantly, bricking the server
    // until a manual restart - exactly what happened during the 2026-09-02 Docker-disk-full
    // outage. Clearing the slot makes the next request retry a fresh connect.
    cache.promise = null;
    cache.conn = null;
    throw err;
  }
  return cache.conn;
}
