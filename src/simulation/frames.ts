
/**
 * Building GAN protocol frames by hand, so the drivers can be driven without a
 * cube in the room.
 *
 * `GanProtocolMessageView` reads a message as one long MSB-first bit string and
 * pulls arbitrary-width words out of it at absolute bit offsets. This is the
 * inverse of that, and it is deliberately written independently rather than by
 * reusing the view — a bug shared by the reader and the writer would cancel out
 * and prove nothing.
 *
 * These lived under `test/` until they were needed by a demo app as well. They
 * are published now, because `SimulatedTransport` without a way to build a
 * frame is a socket with nothing to plug into it.
 */

class BitWriter {

    private bytes: Uint8Array;

    constructor(byteLength: number) {
        this.bytes = new Uint8Array(byteLength);
    }

    /** Write `bitLength` bits of `value`, MSB first, at absolute bit `startBit`. */
    setBitWord(startBit: number, bitLength: number, value: number): this {
        for (let i = 0; i < bitLength; i++) {
            let bit = (value >> (bitLength - 1 - i)) & 1;
            let position = startBit + i;
            let byte = position >> 3;
            let mask = 0x80 >> (position & 7);
            if (bit) this.bytes[byte] |= mask;
            else this.bytes[byte] &= ~mask;
        }
        return this;
    }

    build(): Uint8Array {
        return this.bytes;
    }
}

/** Gen2 frames are twenty bytes: one AES block at each end, overlapping. */
const GEN2_FRAME_BYTES = 20;

/**
 * A Gen2 FACELETS frame for the solved cube.
 *
 * The driver reconstructs the eighth corner and twelfth edge from the sums of
 * the others, so only seven corners and eleven edges are written — exactly as
 * the cube sends them.
 */
function gen2SolvedFaceletsFrame(serial: number): Uint8Array {
    var writer = new BitWriter(GEN2_FRAME_BYTES);
    writer.setBitWord(0, 4, 0x04);
    writer.setBitWord(4, 8, serial);
    for (let i = 0; i < 7; i++) {
        writer.setBitWord(12 + i * 3, 3, i);   // CP
        writer.setBitWord(33 + i * 2, 2, 0);   // CO
    }
    for (let i = 0; i < 11; i++) {
        writer.setBitWord(47 + i * 4, 4, i);   // EP
        writer.setBitWord(91 + i, 1, 0);       // EO
    }
    return writer.build();
}

/** One move, as the cube reports it: a face index, a direction bit and a gap. */
type FrameMove = {
    /** 0 - U, 1 - R, 2 - F, 3 - D, 4 - L, 5 - B */
    face: number;
    /** 0 - CW, 1 - CCW */
    direction: number;
    /** Cube-clock milliseconds since the previous move. */
    elapsed: number;
};

/**
 * A Gen2 MOVE frame.
 *
 * The cube packs up to seven moves into one frame, **newest first**: slot 0 is
 * the move that just happened and slot `n` is `n` moves ago. `serial` names the
 * newest. The driver walks the slots backwards so that events come out in the
 * order they were made, which is why `moves[0]` here is the newest too.
 */
function gen2MoveFrame(serial: number, moves: Array<FrameMove>): Uint8Array {
    var writer = new BitWriter(GEN2_FRAME_BYTES);
    writer.setBitWord(0, 4, 0x02);
    writer.setBitWord(4, 8, serial);
    moves.forEach((move, i) => {
        writer.setBitWord(12 + 5 * i, 4, move.face);
        writer.setBitWord(16 + 5 * i, 1, move.direction);
        writer.setBitWord(47 + 16 * i, 16, move.elapsed);
    });
    return writer.build();
}

/** A Gen2 BATTERY frame. */
function gen2BatteryFrame(level: number): Uint8Array {
    return new BitWriter(GEN2_FRAME_BYTES)
        .setBitWord(0, 4, 0x09)
        .setBitWord(8, 8, level)
        .build();
}

/** A Gen2 HARDWARE frame. `name` is padded or truncated to eight characters. */
function gen2HardwareFrame(name: string, gyroSupported: boolean): Uint8Array {
    var writer = new BitWriter(GEN2_FRAME_BYTES);
    writer.setBitWord(0, 4, 0x05);
    writer.setBitWord(8, 8, 1);    // hardware major
    writer.setBitWord(16, 8, 2);   // hardware minor
    writer.setBitWord(24, 8, 3);   // software major
    writer.setBitWord(32, 8, 4);   // software minor
    var padded = name.padEnd(8, '\0').slice(0, 8);
    for (let i = 0; i < 8; i++) {
        writer.setBitWord(40 + i * 8, 8, padded.charCodeAt(i));
    }
    writer.setBitWord(104, 1, gyroSupported ? 1 : 0);
    return writer.build();
}

/**
 * A Gen2 GYRO frame.
 *
 * Each quaternion component is a sign bit followed by a 15-bit magnitude scaled
 * against 0x7FFF; each velocity component is a sign bit and three magnitude
 * bits. Note the driver's axis convention — it reads w, x, y, z in that order,
 * which is not the order they are usually written in.
 */
function gen2GyroFrame(
    quaternion: { x: number; y: number; z: number; w: number },
    velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
): Uint8Array {
    var signed15 = (v: number) => {
        var magnitude = Math.min(Math.round(Math.abs(v) * 0x7FFF), 0x7FFF);
        return v < 0 ? magnitude | 0x8000 : magnitude;
    };
    var signed3 = (v: number) => {
        var magnitude = Math.min(Math.abs(Math.round(v)), 7);
        return v < 0 ? magnitude | 0x8 : magnitude;
    };
    return new BitWriter(GEN2_FRAME_BYTES)
        .setBitWord(0, 4, 0x01)
        .setBitWord(4, 16, signed15(quaternion.w))
        .setBitWord(20, 16, signed15(quaternion.x))
        .setBitWord(36, 16, signed15(quaternion.y))
        .setBitWord(52, 16, signed15(quaternion.z))
        .setBitWord(68, 4, signed3(velocity.x))
        .setBitWord(72, 4, signed3(velocity.y))
        .setBitWord(76, 4, signed3(velocity.z))
        .build();
}

const SOLVED_FACELETS = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

export type {
    FrameMove
};

export {
    BitWriter,
    GEN2_FRAME_BYTES,
    SOLVED_FACELETS,
    gen2SolvedFaceletsFrame,
    gen2MoveFrame,
    gen2GyroFrame,
    gen2BatteryFrame,
    gen2HardwareFrame
};
