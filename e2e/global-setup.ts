import {seedTestMongo, startTestMongo} from "./mongo-fixture";

export default async function globalSetup() {
  await startTestMongo();
  await seedTestMongo();
}
