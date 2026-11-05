// One research job (lib/pinework.js) in a thread of its own: lib/pinerun.js caps its memory and stops it
// when it runs too long.
import { parentPort, workerData } from "node:worker_threads";
import * as work from "./pinework.js";

const { kind, args } = workerData;
try {
  const result =
    kind === "check" ? work.checkScript(args) : kind === "sweep" ? await work.sweepScript(args) : kind === "scan" ? work.scanSymbol(args) : work.profileBars(args.bars, args.tf);
  parentPort.postMessage({ result });
} catch (e) {
  parentPort.postMessage({ error: String(e?.message || e).slice(0, 300) });
}
