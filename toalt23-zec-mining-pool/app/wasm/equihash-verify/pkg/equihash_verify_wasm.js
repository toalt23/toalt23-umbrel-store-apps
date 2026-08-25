/* @ts-self-types="./equihash_verify_wasm.d.ts" */

/**
 * Verifies an Equihash(200,9) solution against a block header.
 *
 * `header` is the 140-byte pre-solution block header (version..nonce) —
 * the same slice the stratum server already assembles for hashing. This
 * function splits it into the algorithm's `input` (the first 108 bytes)
 * and `nonce` (the last 32 bytes) itself, matching librustzcash's
 * `equihash::is_valid_solution(n, k, input, nonce, soln)` signature.
 *
 * `solution` must NOT include the CompactSize length prefix miners send
 * over the wire — strip that on the JS side first (see readCompactSize in
 * block-header.ts).
 * @param {Uint8Array} header
 * @param {Uint8Array} solution
 * @returns {boolean}
 */
function verify(header, solution) {
    const ptr0 = passArray8ToWasm0(header, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(solution, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.verify(ptr0, len0, ptr1, len1);
    return ret !== 0;
}
exports.verify = verify;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./equihash_verify_wasm_bg.js": import0,
    };
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/equihash_verify_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
