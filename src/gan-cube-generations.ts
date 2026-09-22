
import * as def from './gan-cube-definitions';
import {
    GanCubeEncrypter,
    GanGen2CubeEncrypter,
    GanGen3CubeEncrypter,
    GanGen4CubeEncrypter
} from './gan-cube-encrypter';
import {
    GanProtocolDriver,
    GanGen2ProtocolDriver,
    GanGen3ProtocolDriver,
    GanGen4ProtocolDriver
} from './gan-cube-protocol';

/**
 * Which of GAN's three mutually incompatible BLE protocols a cube speaks.
 *
 * A cube announces this by which primary service it exposes, and nothing else
 * about it can be discovered until it is known — the encryption differs, the
 * command encoding differs, and the state frames differ.
 */
type GanCubeGeneration = 2 | 3 | 4;

/** The BLE identifiers for one protocol generation. */
type GanGenerationProfile = {
    generation: GanCubeGeneration;
    /** Primary service UUID, lowercase. */
    service: string;
    /** Characteristic the host writes commands to. */
    commandCharacteristic: string;
    /** Characteristic the cube pushes state notifications on. */
    stateCharacteristic: string;
};

/**
 * Every generation this library can talk to.
 *
 * Kept as data rather than a chain of `if`s so that a platform adapter can scan
 * for all of them in one pass — `react-native-ble-plx` filters by service UUID
 * at scan time, which is a list, not a sequence of branches.
 */
const GAN_GENERATIONS: Array<GanGenerationProfile> = [
    {
        generation: 2,
        service: def.GAN_GEN2_SERVICE,
        commandCharacteristic: def.GAN_GEN2_COMMAND_CHARACTERISTIC,
        stateCharacteristic: def.GAN_GEN2_STATE_CHARACTERISTIC
    },
    {
        generation: 3,
        service: def.GAN_GEN3_SERVICE,
        commandCharacteristic: def.GAN_GEN3_COMMAND_CHARACTERISTIC,
        stateCharacteristic: def.GAN_GEN3_STATE_CHARACTERISTIC
    },
    {
        generation: 4,
        service: def.GAN_GEN4_SERVICE,
        commandCharacteristic: def.GAN_GEN4_COMMAND_CHARACTERISTIC,
        stateCharacteristic: def.GAN_GEN4_STATE_CHARACTERISTIC
    }
];

/** All known GAN service UUIDs, for scan filters and `optionalServices`. */
const GAN_SERVICES: Array<string> = GAN_GENERATIONS.map((g) => g.service);

/** The profile for a primary service UUID, or `undefined` if it is not a GAN cube. */
function generationForService(serviceUUID: string): GanGenerationProfile | undefined {
    var uuid = serviceUUID.toLowerCase();
    return GAN_GENERATIONS.find((g) => g.service == uuid);
}

/**
 * Turn a MAC address into the six salt bytes GAN's key derivation wants.
 *
 * The bytes go in **reverse** order — this is not a detail to tidy up later; get
 * it backwards and the cube connects, sends frames, and decrypts them to
 * plausible-looking garbage that the driver then reports as impossible moves.
 * Accepts the separators the various platforms produce (`:`, `-`, whitespace).
 */
function saltFromMAC(mac: string): Uint8Array {
    var bytes = mac.split(/[:\-\s]+/).map((c) => parseInt(c, 16));
    if (bytes.length != 6 || bytes.some((b) => !(b >= 0 && b <= 0xFF)))
        throw new Error(`Malformed cube MAC address: ${mac}`);
    return new Uint8Array(bytes.reverse());
}

/**
 * The encrypter for a cube, given its generation and MAC.
 *
 * `deviceName` matters for exactly one case: the Monster Go "AiCube" ships a
 * different Gen2 key from every other cube. Upstream decides this by name
 * prefix and so do we.
 */
function createEncrypter(generation: GanCubeGeneration, mac: string, deviceName?: string): GanCubeEncrypter {
    var salt = saltFromMAC(mac);
    var key = generation == 2 && deviceName?.startsWith('AiCube')
        ? def.GAN_ENCRYPTION_KEYS[1]
        : def.GAN_ENCRYPTION_KEYS[0];
    var keyBytes = new Uint8Array(key.key);
    var ivBytes = new Uint8Array(key.iv);
    switch (generation) {
        case 2: return new GanGen2CubeEncrypter(keyBytes, ivBytes, salt);
        case 3: return new GanGen3CubeEncrypter(keyBytes, ivBytes, salt);
        case 4: return new GanGen4CubeEncrypter(keyBytes, ivBytes, salt);
    }
}

/** The protocol driver for a generation. Drivers are stateful — one per connection. */
function createDriver(generation: GanCubeGeneration): GanProtocolDriver {
    switch (generation) {
        case 2: return new GanGen2ProtocolDriver();
        case 3: return new GanGen3ProtocolDriver();
        case 4: return new GanGen4ProtocolDriver();
    }
}

export type {
    GanCubeGeneration,
    GanGenerationProfile
};

export {
    GAN_GENERATIONS,
    GAN_SERVICES,
    generationForService,
    saltFromMAC,
    createEncrypter,
    createDriver
};
