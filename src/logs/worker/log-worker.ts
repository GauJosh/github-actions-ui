/// <reference lib="webworker" />
// Log worker entry. Served with `connect-src 'none'`: it holds log text but cannot make network requests.
import { createLogWorkerHandler } from "./handler";
import type { FromWorker, ToWorker } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createLogWorkerHandler(
  (message: FromWorker) => scope.postMessage(message),
  (error) => {
    setTimeout(() => {
      throw error;
    });
  },
);
scope.onmessage = (event: MessageEvent<ToWorker>) => handle(event.data);
