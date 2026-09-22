
import { GanCubeConnection } from '../gan-cube-protocol';
import { SimulatedTransport } from '../gan-cube-transport';
import { createGanCubeConnection } from '../gan-cube-connection';
import { createDriver, createEncrypter } from '../gan-cube-generations';
import {
    FrameMove,
    gen2BatteryFrame,
    gen2GyroFrame,
    gen2HardwareFrame,
    gen2MoveFrame,
    gen2SolvedFaceletsFrame
} from './frames';

/** The cube's move vocabulary: six faces, two directions. Nothing else exists. */
const FACES = 'URFDLB';

/**
 * A cube that isn't there.
 *
 * `SimulatedTransport` has always been exported, but on its own it is a socket
 * with nothing to plug into it: a caller holds a transport and has no way to
 * produce a byte sequence the driver will accept. This is the other half.
 *
 * What it is **not** is a fake connection. It builds a genuine
 * `GanCubeTransportConnection` over a genuine Gen2 encrypter and a genuine Gen2
 * driver, and every frame it emits is bit-packed and AES-encrypted exactly as a
 * cube would send it. Nothing is stubbed above the transport, so a consumer
 * driving this is exercising the same decrypt → parse → `events$` path that
 * hardware goes through. A bug anywhere in that path shows up here.
 *
 * The one thing it does not model is cube *state*. `sendFacelets()` always
 * reports the solved cube, because encoding an arbitrary position means writing
 * the Gen2 permutation/orientation layout, and that is a cube model, which does
 * not belong in a BLE library. This matches how a real cube is used in practice:
 * it answers `REQUEST_FACELETS` once on connect, and everything after that is
 * the move stream.
 */
interface SimulatedGanCube {

    /** The connection, indistinguishable in type from a real cube's. */
    readonly connection: GanCubeConnection;

    /** The transport underneath, for asserting on what the connection wrote. */
    readonly transport: SimulatedTransport;

    /**
     * Turn a face, as a move in standard notation: `R`, `R'`, or `R2`.
     *
     * A half turn sends **two frames**, because the protocol has no half turn —
     * a cube reports `R2` as two quarter turns and so does this. Anything that
     * treats `R2` as one event is wrong about real hardware.
     */
    turn(move: string): Promise<void>;

    /** Turn each move of a sequence in order, e.g. `"R U R' U'"`. */
    turns(moves: string): Promise<void>;

    /** Report the solved state, as a cube answers `REQUEST_FACELETS`. */
    sendFacelets(): Promise<void>;

    /** Report a battery level, 0–100. */
    sendBattery(level?: number): Promise<void>;

    /** Report hardware identity and whether the gyroscope is present. */
    sendHardware(): Promise<void>;

    /** Report an orientation. Components are the usual −1…1; velocity is −7…7. */
    sendGyro(
        quaternion: { x: number; y: number; z: number; w: number },
        velocity?: { x: number; y: number; z: number }
    ): Promise<void>;

    /** Drop the link the way switching the cube off would. */
    disconnect(): Promise<void>;
}

type SimulatedGanCubeOptions = {
    /** Advertised name. Must not start with `AiCube` unless you want that key. */
    deviceName?: string;
    /** MAC address, which salts the encryption key — any well-formed one works. */
    deviceMAC?: string;
    /**
     * Hardware name reported by `sendHardware()`.
     *
     * The field on the wire is eight bytes and the driver hands back all eight
     * verbatim, so a shorter name arrives NUL-padded. The default is exactly
     * eight characters for that reason.
     */
    hardwareName?: string;
    /** Whether `sendHardware()` claims a gyroscope. */
    gyroSupported?: boolean;
    /** Battery level reported by `sendBattery()` when none is given. */
    batteryLevel?: number;
};

/**
 * Parse `R`, `R'` or `R2` into the quarter turns the cube would report.
 *
 * Throws rather than ignoring an unknown move: silently dropping a turn would
 * desynchronise the caller's idea of the cube from the driver's, and that shows
 * up much later as an unexplained wrong state.
 */
function quarterTurns(move: string): Array<{ face: number; direction: number }> {
    var text = move.trim();
    var face = FACES.indexOf(text.charAt(0).toUpperCase());
    var suffix = text.slice(1);
    if (face < 0 || !['', "'", '2', '’'].includes(suffix))
        throw new Error(`Not a move this cube can make: ${move}`);
    if (suffix == '2')
        return [{ face, direction: 0 }, { face, direction: 0 }];
    return [{ face, direction: suffix == '' ? 0 : 1 }];
}

/**
 * Build a simulated cube and its connection.
 *
 * The returned promise resolves once the connection is subscribed, so a caller
 * can subscribe to `events$` and start turning immediately. Nothing is emitted
 * until asked for — same as a real cube, which says nothing until commanded.
 */
async function createSimulatedGanCube(options: SimulatedGanCubeOptions = {}): Promise<SimulatedGanCube> {

    var deviceName = options.deviceName ?? 'GANicSIM01';
    var deviceMAC = options.deviceMAC ?? 'AB:12:34:56:78:9A';
    var hardwareName = options.hardwareName ?? 'GANSIM01';
    var gyroSupported = options.gyroSupported ?? true;
    var batteryLevel = options.batteryLevel ?? 87;

    var transport = new SimulatedTransport({ deviceName, deviceMAC });
    var encrypter = createEncrypter(2, deviceMAC, deviceName);
    var driver = createDriver(2);
    var connection = await createGanCubeConnection(transport, encrypter, driver);

    /**
     * The move counter, mod 256, exactly as the cube keeps it.
     *
     * This is the part that cannot be faked casually: the driver derives how
     * many moves it missed from the forward distance between this and the last
     * serial it saw, and refuses everything until a facelets frame has given it
     * a starting point. Emitting incoherent serials produces phantom moves,
     * which is precisely the failure the driver exists to make impossible.
     */
    var serial = 0x00;

    /** Host clock at the previous move, for a believable cube-clock gap. */
    var lastMoveAt = Date.now();

    var deliver = (frame: Uint8Array) => Promise.resolve(transport.emit(encrypter.encrypt(frame)));

    var sendMove = async (turn: { face: number; direction: number }) => {
        var at = Date.now();
        // Never zero: the driver reads a zero gap as a 16-bit register overflow
        // and substitutes host time, which would quietly discard our timing.
        var elapsed = Math.max(1, Math.min(at - lastMoveAt, 0xFFFF));
        lastMoveAt = at;
        serial = (serial + 1) & 0xFF;
        var move: FrameMove = { face: turn.face, direction: turn.direction, elapsed };
        await deliver(gen2MoveFrame(serial, [move]));
    };

    var turn = async (move: string): Promise<void> => {
        for (let quarter of quarterTurns(move)) {
            await sendMove(quarter);
        }
    };

    return {

        connection,
        transport,
        turn,

        async turns(moves: string): Promise<void> {
            for (let move of moves.trim().split(/\s+/).filter((m) => m.length > 0)) {
                await turn(move);
            }
        },

        async sendFacelets(): Promise<void> {
            await deliver(gen2SolvedFaceletsFrame(serial));
        },

        async sendBattery(level?: number): Promise<void> {
            await deliver(gen2BatteryFrame(level ?? batteryLevel));
        },

        async sendHardware(): Promise<void> {
            await deliver(gen2HardwareFrame(hardwareName, gyroSupported));
        },

        async sendGyro(
            quaternion: { x: number; y: number; z: number; w: number },
            velocity?: { x: number; y: number; z: number }
        ): Promise<void> {
            await deliver(gen2GyroFrame(quaternion, velocity));
        },

        async disconnect(): Promise<void> {
            await connection.disconnect();
        }

    };
}

export type {
    SimulatedGanCube,
    SimulatedGanCubeOptions
};

export {
    createSimulatedGanCube
};
