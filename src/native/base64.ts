
/**
 * Base64 in pure TypeScript.
 *
 * `react-native-ble-plx` hands characteristic values over the bridge as base64
 * strings and takes writes the same way, so every byte in and out of a phone
 * passes through here. It is written out rather than taken from a dependency
 * because the alternatives are all worse on React Native: `atob`/`btoa` are not
 * in the Hermes global scope, `Buffer` is a Node shim that has to be polyfilled,
 * and both would be a runtime dependency for forty lines of arithmetic.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup, built once. `-1` marks a character that is not base64. */
const LOOKUP: Array<number> = (() => {
    var table = new Array<number>(256).fill(-1);
    for (let i = 0; i < ALPHABET.length; i++) {
        table[ALPHABET.charCodeAt(i)] = i;
    }
    return table;
})();

/** Encode bytes as a base64 string, with padding. */
function toBase64(bytes: Uint8Array): string {
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        let n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    var remaining = bytes.length - i;
    if (remaining == 1) {
        let n = bytes[i] << 16;
        out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + '==';
    } else if (remaining == 2) {
        let n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
    }
    return out;
}

/**
 * Decode a base64 string to bytes.
 *
 * Padding is optional and any character outside the alphabet — including the
 * newlines some stacks insert — is skipped rather than rejected, because a
 * decoder that throws on a stray byte turns a cosmetic difference between BLE
 * stacks into a connection that never works.
 */
function fromBase64(text: string): Uint8Array {
    var values: Array<number> = [];
    for (let i = 0; i < text.length; i++) {
        let value = LOOKUP[text.charCodeAt(i)];
        if (value >= 0) values.push(value);
    }
    var byteLength = Math.floor((values.length * 6) / 8);
    var bytes = new Uint8Array(byteLength);
    var accumulator = 0;
    var bits = 0;
    var out = 0;
    for (let value of values) {
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes[out++] = (accumulator >> bits) & 0xFF;
        }
    }
    return bytes;
}

export {
    toBase64,
    fromBase64
};
