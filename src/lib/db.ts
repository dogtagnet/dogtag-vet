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
  cache.conn = await cache.promise;
  return cache.conn;
}
