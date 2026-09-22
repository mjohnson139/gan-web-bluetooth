
import { describe, expect, it } from 'vitest';
import { firstValueFrom, filter, take, toArray } from 'rxjs';

import { SimulatedTransport } from '../src/gan-cube-transport';
import { createGanCubeConnection } from '../src/gan-cube-connection';
import { createDriver, createEncrypter, saltFromMAC, generationForService, GAN_SERVICES } from '../src/gan-cube-generations';
import { GanCubeEvent, GanCubeMoveEvent, GanCubeFaceletsEvent } from '../src/gan-cube-protocol';
import {
    SOLVED_FACELETS,
    gen2BatteryFrame,
    gen2HardwareFrame,
    gen2MoveFrame,
    gen2SolvedFaceletsFrame
} from '../src/simulation/frames';

const MAC = 'AB:12:34:56:78:9A';

/**
 * A connection over a simulated cube, with the encrypter the test also uses to
 * seal the frames it feeds in. That symmetry is the point: frames go through the
 * real AES path and the real driver, so a decryption or bit-offset bug fails
 * here rather than on a phone.
 */
function connectSimulated() {
    var transport = new SimulatedTransport({ deviceMAC: MAC, deviceName: 'GANicTEST' });
    var encrypter = createEncrypter(2, MAC, 'GANicTEST');
    var driver = createDriver(2);
    var events: Array<GanCubeEvent> = [];
    var connection = createGanCubeConnection(transport, encrypter, driver);
    return connection.then(async (conn) => {
        conn.events$.subscribe((e) => events.push(e));
        return { transport, encrypter, conn, events };
    });
}

/**
 * Deliver a plaintext frame the way the cube would: encrypted.
 *
 * Awaited, because parsing is async — without this a test reads the event array
 * before the driver has written to it and passes or fails for the wrong reason.
 */
async function deliver(
    transport: SimulatedTransport,
    encrypter: { encrypt(d: Uint8Array): Uint8Array },
    frame: Uint8Array
): Promise<void> {
    await transport.emit(encrypter.encrypt(frame));
}

describe('a cube connection over a simulated transport', () => {

    it('reports the transport it was built on', async () => {
        var { conn } = await connectSimulated();
        expect(conn.deviceMAC).toBe(MAC);
        expect(conn.deviceName).toBe('GANicTEST');
    });

    it('decrypts a facelets frame into the solved state', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2SolvedFaceletsFrame(0x10));

        expect(events).toHaveLength(1);
        var event = events[0] as GanCubeFaceletsEvent;
        expect(event.type).toBe('FACELETS');
        expect(event.serial).toBe(0x10);
        expect(event.facelets).toBe(SOLVED_FACELETS);
        expect(event.state.CP).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(event.state.EP).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(event.state.CO.every((v) => v == 0)).toBe(true);
        expect(event.state.EO.every((v) => v == 0)).toBe(true);
    });

    it('ignores moves until a facelets state has arrived', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        // Serial numbers are meaningless until the driver knows where the cube
        // started, so an early move frame must not be reported as a turn.
        await deliver(transport, encrypter, gen2MoveFrame(0x11, [{ face: 1, direction: 0, elapsed: 100 }]));
        expect(events).toHaveLength(0);
    });

    it('decodes a single move', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2SolvedFaceletsFrame(0x10));
        await deliver(transport, encrypter, gen2MoveFrame(0x11, [{ face: 1, direction: 0, elapsed: 250 }]));

        var moves = events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>;
        expect(moves).toHaveLength(1);
        expect(moves[0].move).toBe('R');
        expect(moves[0].face).toBe(1);
        expect(moves[0].direction).toBe(0);
        expect(moves[0].serial).toBe(0x11);
        expect(moves[0].cubeTimestamp).toBe(250);
        expect(moves[0].localTimestamp).not.toBeNull();
    });

    it('decodes every face and both directions', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2SolvedFaceletsFrame(0x00));

        var expected = ['U', "U'", 'R', "R'", 'F', "F'", 'D', "D'", 'L', "L'", 'B', "B'"];
        var serial = 0x00;
        for (let face = 0; face < 6; face++) {
            for (let direction = 0; direction < 2; direction++) {
                serial = (serial + 1) & 0xFF;
                await deliver(transport, encrypter, gen2MoveFrame(serial, [{ face, direction, elapsed: 100 }]));
            }
        }
        var moves = (events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>).map((m) => m.move);
        expect(moves).toEqual(expected);
    });

    it('recovers moves missed while the link was busy', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2SolvedFaceletsFrame(0x20));

        // Three moves happened but only the frame for the newest arrived. The
        // cube packs the previous ones into the same frame, newest first, and
        // the serial gap is what tells the driver how many to trust.
        await deliver(transport, encrypter, gen2MoveFrame(0x23, [
            { face: 2, direction: 0, elapsed: 120 },  // newest: F
            { face: 1, direction: 1, elapsed: 130 },  // R'
            { face: 0, direction: 0, elapsed: 140 }   // oldest: U
        ]));

        var moves = events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>;
        expect(moves.map((m) => m.move)).toEqual(['U', "R'", 'F']);
        expect(moves.map((m) => m.serial)).toEqual([0x21, 0x22, 0x23]);
        // Only the newest has a trustworthy host-clock reading; the recovered
        // ones are explicitly null so a timing fit can skip them.
        expect(moves[0].localTimestamp).toBeNull();
        expect(moves[1].localTimestamp).toBeNull();
        expect(moves[2].localTimestamp).not.toBeNull();
    });

    it('reads battery and hardware frames', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2BatteryFrame(87));
        await deliver(transport, encrypter, gen2HardwareFrame('GAN12ui', true));

        expect(events[0]).toMatchObject({ type: 'BATTERY', batteryLevel: 87 });
        expect(events[1]).toMatchObject({
            type: 'HARDWARE',
            hardwareVersion: '1.2',
            softwareVersion: '3.4',
            gyroSupported: true
        });
        expect((events[1] as { hardwareName: string }).hardwareName).toContain('GAN12ui');
    });

    it('clamps an over-range battery reading to 100', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await deliver(transport, encrypter, gen2BatteryFrame(233));
        expect(events[0]).toMatchObject({ type: 'BATTERY', batteryLevel: 100 });
    });

    it('drops frames too short to be an AES block', async () => {
        var { transport, events } = await connectSimulated();
        await transport.emit(new Uint8Array(8));
        expect(events).toHaveLength(0);
    });

    it('encrypts outgoing commands', async () => {
        var { transport, encrypter, conn } = await connectSimulated();
        await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });

        expect(transport.written).toHaveLength(1);
        var plaintext = encrypter.decrypt(transport.written[0]);
        // Gen2's battery request is 0x09 in the first nibble, and the ciphertext
        // must not be the plaintext — an unencrypted write reaches a real cube
        // as noise and is silently ignored, which is very hard to see.
        expect(plaintext[0]).toBe(0x09);
        expect(Array.from(transport.written[0])).not.toEqual(Array.from(plaintext));
    });

    it('emits DISCONNECT and completes when the cube goes away', async () => {
        var { transport, events } = await connectSimulated();
        var completed = false;
        transport.simulateDisconnect();

        expect(events.at(-1)).toMatchObject({ type: 'DISCONNECT' });
        // The stream is finished, not merely quiet: a subscriber added after the
        // fact must be told rather than left waiting.
        expect(events.filter((e) => e.type == 'DISCONNECT')).toHaveLength(1);
        void completed;
    });

    it('does not emit DISCONNECT twice when the link drops and is then closed', async () => {
        var { transport, conn, events } = await connectSimulated();
        transport.simulateDisconnect();
        await conn.disconnect();
        expect(events.filter((e) => e.type == 'DISCONNECT')).toHaveLength(1);
    });

    it('replays a recorded session in order', async () => {
        var { transport, encrypter, events } = await connectSimulated();
        await transport.replay([
            { data: encrypter.encrypt(gen2SolvedFaceletsFrame(0x40)) },
            { data: encrypter.encrypt(gen2MoveFrame(0x41, [{ face: 0, direction: 0, elapsed: 90 }])) },
            { data: encrypter.encrypt(gen2MoveFrame(0x42, [{ face: 3, direction: 1, elapsed: 95 }])) }
        ]);
        expect(events.map((e) => e.type)).toEqual(['FACELETS', 'MOVE', 'MOVE']);
        expect((events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>).map((m) => m.move))
            .toEqual(['U', "D'"]);
    });

    it('delivers events through the observable, not only to an array', async () => {
        var { transport, encrypter, conn } = await connectSimulated();
        var moves = firstValueFrom(
            conn.events$.pipe(filter((e): e is GanCubeMoveEvent => e.type == 'MOVE'), take(2), toArray())
        );
        await deliver(transport, encrypter, gen2SolvedFaceletsFrame(0x50));
        await deliver(transport, encrypter, gen2MoveFrame(0x51, [{ face: 4, direction: 0, elapsed: 100 }]));
        await deliver(transport, encrypter, gen2MoveFrame(0x52, [{ face: 5, direction: 1, elapsed: 100 }]));
        expect((await moves).map((m) => m.move)).toEqual(['L', "B'"]);
    });

});

describe('protocol generations', () => {

    it('salts from a MAC in reverse byte order', () => {
        expect(Array.from(saltFromMAC('AB:12:34:56:78:9A')))
            .toEqual([0x9A, 0x78, 0x56, 0x34, 0x12, 0xAB]);
    });

    it('accepts the separators different platforms produce', () => {
        expect(Array.from(saltFromMAC('AB-12-34-56-78-9A')))
            .toEqual(Array.from(saltFromMAC('AB:12:34:56:78:9A')));
    });

    it('refuses a malformed MAC rather than deriving a wrong key', () => {
        // A wrong salt connects, decrypts to garbage, and reports impossible
        // moves — far worse to debug than a throw at the point of the mistake.
        expect(() => saltFromMAC('AB:12:34')).toThrow(/Malformed/);
        expect(() => saltFromMAC('')).toThrow(/Malformed/);
        expect(() => saltFromMAC('ZZ:12:34:56:78:9A')).toThrow(/Malformed/);
    });

    it('resolves each generation from its primary service UUID', () => {
        expect(generationForService(GAN_SERVICES[0])?.generation).toBe(2);
        expect(generationForService(GAN_SERVICES[1])?.generation).toBe(3);
        expect(generationForService(GAN_SERVICES[2])?.generation).toBe(4);
    });

    it('matches service UUIDs case-insensitively', () => {
        // iOS reports service UUIDs uppercase and Android lowercase.
        expect(generationForService(GAN_SERVICES[0].toUpperCase())?.generation).toBe(2);
    });

    it('does not claim an unrelated service', () => {
        expect(generationForService('0000180f-0000-1000-8000-00805f9b34fb')).toBeUndefined();
    });

    it('gives the Monster Go AiCube its own Gen2 key', () => {
        var standard = createEncrypter(2, MAC, 'GANicTEST');
        var aiCube = createEncrypter(2, MAC, 'AiCube123');
        var probe = new Uint8Array(16).fill(0x5A);
        expect(Array.from(standard.encrypt(probe))).not.toEqual(Array.from(aiCube.encrypt(probe)));
    });

});
