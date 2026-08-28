import {stopTestMongo} from "./mongo-fixture";

export default async function globalTeardown() {
  await stopTestMongo();
}
