import {stopTestMongo} from "./mongo-fixture";
import {stopStartedRpcStub} from "./rpcStub";

export default async function globalTeardown() {
  await stopTestMongo();
  await stopStartedRpcStub();
}
