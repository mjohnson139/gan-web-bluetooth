import { describe, expect, it } from 'vitest';

import { createSimulatedGanCube } from '../src/simulation';
import { SOLVED_FACELETS } from '../src/simulation/frames';
import {
    GanCubeEvent,
    GanCubeFaceletsEvent,
    GanCubeGyroEvent,
    GanCubeHardwareEvent,
    GanCubeMoveEvent
} from '../src/gan-cube-protocol';

/**
 * The simulated cube, driven the way a consumer would drive it.
 *
 * `pipeline.test.ts` already proves the driver against hand-built frames. What
 * is being tested here is the layer above: that the published helper emits
 * frames a real driver accepts, with coherent serials and sane timing. It has
 * no access to the driver's internals — it asserts only on `events$`, which is
 * all a consumer can see either.
 */
async function cubeWithEvents() {
    var cube = await createSimulatedGanCube();
    var events: Array<GanCubeEvent> = [];
    cube.connection.events$.subscribe((e) => events.push(e));
    return { cube, events };
}

const moves = (events: Array<GanCubeEvent>) =>
    (events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>).map((e) => e.move);

describe('a simulated cube', () => {

    it('presents itself as a cube', async () => {
        var { cube } = await cubeWithEvents();
        expect(cube.connection.deviceName).toBe('GANicSIM01');
        expect(cube.connection.deviceMAC).toBe('AB:12:34:56:78:9A');
    });

    it('answers a facelets request with the solved state', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();

        expect(events).toHaveLength(1);
        var event = events[0] as GanCubeFaceletsEvent;
        expect(event.type).toBe('FACELETS');
        expect(event.facelets).toBe(SOLVED_FACELETS);
    });

    it('reports hardware and battery', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendHardware();
        await cube.sendBattery(42);

        var hardware = events.find((e) => e.type == 'HARDWARE') as GanCubeHardwareEvent;
        expect(hardware.hardwareName).toBe('GANSIM01');
        expect(hardware.gyroSupported).toBe(true);
        expect(events.find((e) => e.type == 'BATTERY')).toMatchObject({ batteryLevel: 42 });
    });

    it('answers the commands an app sends on connect', async () => {
        var { cube, events } = await cubeWithEvents();

        // Exactly what every app does on connect, and what nothing answered
        // before: the command goes out encrypted and comes back decoded.
        await cube.connection.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
        await cube.connection.sendCubeCommand({ type: 'REQUEST_FACELETS' });
        await cube.connection.sendCubeCommand({ type: 'REQUEST_BATTERY' });
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(events.map((e) => e.type).sort()).toEqual(['BATTERY', 'FACELETS', 'HARDWARE']);
    });

    it('does not answer before the command has been sent', async () => {
        var { cube, events } = await cubeWithEvents();

        // The reply is deferred by a turn of the event loop, so the promise a
        // caller awaits resolves first — the order real hardware gives.
        await cube.connection.sendCubeCommand({ type: 'REQUEST_BATTERY' });
        expect(events).toHaveLength(0);

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(events.map((e) => e.type)).toEqual(['BATTERY']);
    });

    it('turns a face', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        await cube.turn('R');

        expect(moves(events)).toEqual(['R']);
    });

    it('turns counterclockwise', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        await cube.turn("U'");

        expect(moves(events)).toEqual(["U'"]);
    });

    it('splits a half turn into the two quarter turns a cube actually reports', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        await cube.turn('F2');

        // The protocol has no half turn. Anything that reports F2 as one event
        // is not modelling the hardware.
        expect(moves(events)).toEqual(['F', 'F']);
    });

    it('turns a sequence in order', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        await cube.turns("R U R' U'");

        expect(moves(events)).toEqual(['R', 'U', "R'", "U'"]);
    });

    it('keeps serials coherent past the 256 wrap', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        for (let i = 0; i < 300; i++) {
            await cube.turn('R');
        }

        // The driver derives missed moves from the forward distance between
        // serials. An off-by-one across the wrap shows up as phantom or
        // swallowed turns, so the count is the assertion that matters.
        expect(moves(events)).toHaveLength(300);
        expect(moves(events).every((m) => m == 'R')).toBe(true);
    });

    it('advances the cube clock monotonically', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendFacelets();
        await cube.turns('R U F');

        var stamps = (events.filter((e) => e.type == 'MOVE') as Array<GanCubeMoveEvent>)
            .map((e) => e.cubeTimestamp);
        expect(stamps[0]).toBeGreaterThan(0);
        expect(stamps[1]).toBeGreaterThan(stamps[0]!);
        expect(stamps[2]).toBeGreaterThan(stamps[1]!);
    });

    it('ignores moves made before the state is known, as a real cube does', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.turn('R');

        expect(events).toHaveLength(0);
    });

    it('reports an orientation', async () => {
        var { cube, events } = await cubeWithEvents();
        await cube.sendGyro({ x: 0, y: 0, z: 0, w: 1 }, { x: 1, y: -2, z: 3 });

        var gyro = events[0] as GanCubeGyroEvent;
        expect(gyro.type).toBe('GYRO');
        expect(gyro.quaternion.w).toBeCloseTo(1, 3);
        expect(gyro.quaternion.x).toBeCloseTo(0, 3);
        expect(gyro.velocity).toEqual({ x: 1, y: -2, z: 3 });
    });

    it('refuses a move the cube could not make', async () => {
        var { cube } = await cubeWithEvents();
        // Silently dropping M would desynchronise the caller's model from the
        // driver's, and surface much later as an unexplained wrong state.
        await expect(cube.turn('M')).rejects.toThrow(/Not a move/);
        await expect(cube.turn("R3")).rejects.toThrow(/Not a move/);
    });

    it('drops the link on disconnect', async () => {
        var { cube, events } = await cubeWithEvents();
        var completed = false;
        cube.connection.events$.subscribe({ complete: () => { completed = true; } });

        await cube.disconnect();

        expect(events.some((e) => e.type == 'DISCONNECT')).toBe(true);
        expect(completed).toBe(true);
    });

});
