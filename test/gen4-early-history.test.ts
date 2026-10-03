import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GanGen4ProtocolDriver, GanCubeEvent, GanCubeMoveEvent, GanCubeRawConnection } from '../src/gan-cube-protocol';
import { BitWriter } from '../src/simulation/frames';

/**
 * The Gen4 driver (GANi4, GAN12 ui Maglev, GAN14 ui FreePlay) rebuilds a lost
 * move report from the cube's move history. A GANi4 reports a slice turn as two
 * face turns and often loses the second report; its periodic FACELETS event
 * then carries the lost move's serial well before the person's next turn.
 *
 * These tests drive the driver with plaintext Gen4 frames on fake timers and a
 * fake cube that answers a history request after one simulated round trip, so
 * the time at which each move comes out of the driver can be checked.
 */

const ROUND_TRIP_MS = 30;
const SETTLE_MS = 100;

const FACE_MASK = [2, 32, 8, 1, 16, 4];          // U R F D L B, as in MOVE frames
const HISTORY_FACE_CODE = [1, 5, 3, 0, 4, 2];    // code for U R F D L B in MOVE_HISTORY frames

type Turn = { face: number, direction: number };

function moveFrame(serial: number, turn: Turn, cubeTimestamp: number): Uint8Array {
    var w = new BitWriter(20);
    w.setBitWord(0, 8, 0x01);
    w.setBitWord(8, 8, 9);
    // 32-bit little-endian cube timestamp, 16-bit little-endian serial
    for (let i = 0; i < 4; i++) w.setBitWord(16 + 8 * i, 8, (cubeTimestamp >> (8 * i)) & 0xFF);
    w.setBitWord(48, 8, serial & 0xFF);
    w.setBitWord(56, 8, (serial >> 8) & 0xFF);
    w.setBitWord(64, 2, turn.direction);
    w.setBitWord(66, 6, FACE_MASK[turn.face]);
    return w.build();
}

function faceletsFrame(serial: number): Uint8Array {
    var w = new BitWriter(20);
    w.setBitWord(0, 8, 0xED);
    w.setBitWord(8, 8, 18);
    w.setBitWord(16, 8, serial & 0xFF);
    w.setBitWord(24, 8, (serial >> 8) & 0xFF);
    for (let i = 0; i < 7; i++) w.setBitWord(32 + i * 3, 3, i);
    for (let i = 0; i < 11; i++) w.setBitWord(69 + i * 4, 4, i);
    return w.build();
}

/** The cube's answer to `D1 04 serial 00 count 00`: moves serial, serial-1, ... */
function historyFrame(startSerial: number, count: number, history: Map<number, Turn>): Uint8Array {
    var w = new BitWriter(20);
    w.setBitWord(0, 8, 0xD1);
    w.setBitWord(8, 8, count / 2 + 1);
    w.setBitWord(16, 8, startSerial);
    for (let i = 0; i < count; i++) {
        let turn = history.get((startSerial - i) & 0xFF);
        // A serial the cube has no move for reads as zero bits, i.e. D
        w.setBitWord(24 + 4 * i, 3, turn ? HISTORY_FACE_CODE[turn.face] : 0);
        w.setBitWord(27 + 4 * i, 1, turn ? turn.direction : 0);
    }
    return w.build();
}

const R_PRIME: Turn = { face: 1, direction: 1 };
const L: Turn = { face: 4, direction: 0 };
const F_PRIME: Turn = { face: 2, direction: 1 };
const B: Turn = { face: 5, direction: 0 };

type Delivered = { at: number, serial: number, move: string, rebuilt: boolean };

/**
 * A driver wired to a fake cube. Time starts at 0. `answers` turns the cube's
 * replies to history requests off, to simulate lost requests or responses.
 */
function harness(options: { answers?: boolean } = {}) {
    var driver = new GanGen4ProtocolDriver();
    var history = new Map<number, Turn>();
    var requests: Array<{ at: number, bytes: number[] }> = [];
    var delivered: Delivered[] = [];
    var answers = options.answers ?? true;

    var record = (events: GanCubeEvent[]) => {
        for (let e of events) {
            if (e.type == 'MOVE') {
                let m = e as GanCubeMoveEvent;
                delivered.push({ at: Date.now(), serial: m.serial, move: m.move, rebuilt: m.localTimestamp == null });
            }
        }
    };

    var conn: GanCubeRawConnection = {
        sendCommandMessage: async (message: Uint8Array) => {
            requests.push({ at: Date.now(), bytes: Array.from(message.slice(0, 6)) });
            if (message[0] == 0xD1 && answers) {
                let startSerial = message[2], count = message[4];
                setTimeout(() => {
                    driver.handleStateEvent(conn, historyFrame(startSerial, count, history)).then(record);
                }, ROUND_TRIP_MS);
            }
        },
        disconnect: async () => { throw new Error('the driver gave up and disconnected'); }
    };

    var feed = async (frame: Uint8Array) => record(await driver.handleStateEvent(conn, frame));

    return {
        driver, history, requests, delivered, feed,
        /** The person turns the cube; `reported` false means the report is lost. */
        turn: async (serial: number, turn: Turn, reported = true) => {
            history.set(serial & 0xFF, turn);
            if (reported) await feed(moveFrame(serial, turn, Date.now()));
        },
        /** A report that was in flight arrives now. */
        report: async (serial: number) => feed(moveFrame(serial, history.get(serial & 0xFF)!, Date.now())),
        facelets: async (serial: number) => feed(faceletsFrame(serial)),
        at: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms - Date.now()); },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'hrtime'], now: 0 });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Gen4 driver, a slice turn whose second report is lost', () => {

    // Timeline from a real GANi4 recording (an M': serial 14 L reported, 15 R'
    // lost; the cube's state with serial 15 came 98 ms later; the person's next
    // turn 845 ms after that). Times are shifted so that serial 14 is at 1000.
    async function lostSliceHalf() {
        var cube = harness();
        await cube.facelets(13);
        await cube.at(1000);
        await cube.turn(14, L);
        await cube.turn(15, R_PRIME, false);
        await cube.at(1098);
        await cube.facelets(15);
        await cube.at(1943);
        await cube.turn(16, F_PRIME);
        await cube.turn(17, B);
        await cube.at(2500);
        return cube;
    }

    it('delivers the lost half one settle delay and one round trip after the early state', async () => {
        var cube = await lostSliceHalf();
        var lost = cube.delivered.find(d => d.serial == 15)!;
        expect(lost.rebuilt).toBe(true);
        expect(lost.move).toBe("R'");
        expect(lost.at).toBe(1098 + SETTLE_MS + ROUND_TRIP_MS);
        // Before the change it only came with the next turn, at 1943
        expect(lost.at).toBeLessThan(1943);
    });

    it('asks once, and delivers every move once and in order', async () => {
        var cube = await lostSliceHalf();
        expect(cube.requests).toHaveLength(1);
        // Asks from serial 16 back; the cube's history is odd-aligned, so 15 and 14
        expect(cube.requests[0]).toEqual({ at: 1198, bytes: [0xD1, 0x04, 15, 0, 2, 0] });
        expect(cube.delivered.map(d => d.serial)).toEqual([14, 15, 16, 17]);
        expect(cube.delivered.map(d => d.move)).toEqual(['L', "R'", "F'", 'B']);
    });
});

describe('Gen4 driver, a state that only overtook a report in flight', () => {

    it('does not ask when the report arrives within the settle delay', async () => {
        var cube = harness();
        await cube.facelets(13);
        await cube.at(1000);
        await cube.turn(14, L);
        await cube.turn(15, R_PRIME, false);
        await cube.at(1010);
        await cube.facelets(15);
        await cube.at(1046);              // 36 ms behind its state, as recorded
        await cube.report(15);
        await cube.at(1600);
        expect(cube.requests).toHaveLength(0);
        expect(cube.delivered).toEqual([
            { at: 1000, serial: 14, move: 'L', rebuilt: false },
            { at: 1046, serial: 15, move: "R'", rebuilt: false },
        ]);
    });

    it('drops the late report when the history got there first, and keeps going', async () => {
        var cube = harness();
        await cube.facelets(169);
        await cube.at(1000);
        await cube.turn(170, L);
        await cube.turn(171, R_PRIME, false);
        await cube.turn(172, L, false);
        await cube.at(1337);
        await cube.facelets(172);
        await cube.at(1474);              // 137 ms behind their state, as recorded
        await cube.report(171);
        await cube.report(172);
        await cube.at(1600);
        await cube.turn(173, B);
        await cube.at(2000);
        expect(cube.delivered.map(d => [d.serial, d.rebuilt])).toEqual([
            [170, false], [171, true], [172, true], [173, false]
        ]);
        expect(cube.requests).toHaveLength(1);
    });
});

describe('Gen4 driver, history requests are bounded', () => {

    it('retries twice when the cube does not answer, then waits for the old paths', async () => {
        var cube = harness({ answers: false });
        await cube.facelets(13);
        await cube.at(1000);
        await cube.turn(14, L);
        await cube.turn(15, R_PRIME, false);
        await cube.at(1100);
        await cube.facelets(15);
        await cube.at(1150);
        await cube.facelets(15);          // a repeated state does not start a second timer
        await cube.at(1900);
        expect(cube.requests.map(r => r.at)).toEqual([1200, 1450, 1700]);
        // The periodic state, once moves are quiet for 500 ms, still asks as it always did:
        // once per state event, about once a second, never more.
        await cube.facelets(15);
        await cube.at(2900);
        await cube.facelets(15);
        await cube.at(4000);
        expect(cube.requests.map(r => r.at)).toEqual([1200, 1450, 1700, 1900, 2900]);
        expect(cube.delivered.map(d => d.serial)).toEqual([14]);
    });

    it('delivers a move once when two history answers carry it, and an answer cancels the pending request', async () => {
        var cube = harness();
        await cube.facelets(13);
        await cube.at(1000);
        await cube.turn(14, L);
        await cube.turn(15, R_PRIME, false);
        await cube.at(1100);
        await cube.facelets(15);
        await cube.at(1150);
        // An answer (to some earlier request) arrives before the settle delay is over
        await cube.feed(historyFrame(15, 2, cube.history));
        await cube.at(1300);
        // and a second answer for the same window after that
        await cube.feed(historyFrame(15, 2, cube.history));
        await cube.at(1400);
        expect(cube.delivered.map(d => [d.serial, d.at])).toEqual([[14, 1000], [15, 1150]]);
        expect(cube.requests).toHaveLength(0);
    });

    it('does not ask for a state far ahead of the last report', async () => {
        var cube = harness();
        await cube.facelets(13);
        await cube.at(1000);
        await cube.turn(14, L);
        await cube.at(1100);
        await cube.facelets(40);
        await cube.at(1450);
        expect(cube.requests).toHaveLength(0);
    });
});

describe('Gen4 driver, the serial wraps from 255 to 0', () => {

    it('rebuilds a lost 255 early, without asking past the wrap', async () => {
        var cube = harness();
        await cube.facelets(253);
        await cube.at(1000);
        await cube.turn(254, L);
        await cube.turn(255, R_PRIME, false);
        await cube.at(1050);
        await cube.facelets(255);
        await cube.at(1400);
        expect(cube.requests).toEqual([{ at: 1150, bytes: [0xD1, 0x04, 255, 0, 2, 0] }]);
        expect(cube.delivered.map(d => [d.serial, d.rebuilt])).toEqual([[254, false], [255, true]]);
        await cube.turn(0, F_PRIME);
        await cube.turn(1, B);
        await cube.at(1500);
        expect(cube.delivered.map(d => d.serial)).toEqual([254, 255, 0, 1]);
    });

    it('does not ask early for a state with serial 0 (firmware bug), and the next move still recovers it', async () => {
        var cube = harness();
        await cube.facelets(254);
        await cube.at(1000);
        await cube.turn(255, L);
        await cube.turn(0, R_PRIME, false);
        await cube.at(1050);
        await cube.facelets(0);
        await cube.at(1400);
        expect(cube.requests).toHaveLength(0);
        await cube.turn(1, B);
        await cube.at(1500);
        expect(cube.requests).toHaveLength(1);
        expect(cube.delivered.map(d => [d.serial, d.rebuilt])).toEqual([[255, false], [0, true], [1, false]]);
    });
});
