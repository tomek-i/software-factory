// One process of the registry's concurrency test: waits until the start time in argv[4] (so all
// processes write at once, not as each finishes starting up), then adds argv[3]-0..4 to the list in argv[2]. A loaded CI machine may
// queue the 40 writes for a while, which is not what this test is about, hence the long lock timeout.
import { registerProject } from "../src/registry.js";

const [file, path, start] = process.argv.slice(2);
while (Date.now() < Number(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
for (let i = 0; i < 5; i++) registerProject({ path: `${path!}-${i}`, name: `p-${process.pid}-${i}` }, { file: file!, lockTimeoutMs: 60_000 });
